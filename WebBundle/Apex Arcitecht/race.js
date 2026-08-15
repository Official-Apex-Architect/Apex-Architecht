"use strict";
/**
 * Apex Architect — 2D Track Racer
 * Loads a saved circuit (same localStorage store the designer writes to),
 * rebuilds its bezier centerline using the exact same maths as the editor,
 * and races a top-down F1 car around it.
 */

const STORAGE_KEY = 'apex_projects_v1';
const TRACK_WIDTH = 36;        // world units, matches the editor's main road
const SAMPLES_PER_SEG = 60;    // bezier subdivisions per segment

// ── Car class ───────────────────────────────────────────────────────────
const CAR_CLASSES = {
    // `topKmh` is the real top speed used for the HUD; `grip` is the lateral
    // grip multiplier (how fast the car can carry through corners).
    f1: {
        key: 'f1', label: 'Formula 1', accent: '#e10600',
        speed: 1.30, body: '#e10600', detail: '#111', length: 30, width: 13,
        topKmh: 340, grip: 1.30,
    },
};

function resolveCarClass() {
    return CAR_CLASSES.f1;
}

// ── Geometry (ported 1:1 from the editor so layouts are identical) ───────
function getCtrlPts(nodes, isClosed, i) {
    const n = nodes[i];
    const len = nodes.length;
    let pPrev, pNext;
    if (isClosed) {
        pPrev = nodes[(i - 1 + len) % len];
        pNext = nodes[(i + 1) % len];
    } else {
        pPrev = i > 0 ? nodes[i - 1]
            : { x: n.x - ((nodes[i + 1]?.x - n.x) || 100), y: n.y - ((nodes[i + 1]?.y - n.y) || 0) };
        pNext = i < len - 1 ? nodes[i + 1]
            : { x: n.x + ((n.x - nodes[i - 1]?.x) || 100), y: n.y + ((n.y - nodes[i - 1]?.y) || 0) };
    }
    if (!pPrev) pPrev = { x: n.x - 50, y: n.y };
    if (!pNext) pNext = { x: n.x + 50, y: n.y };
    let tx = (pNext.x - pPrev.x) / 6;
    let ty = (pNext.y - pPrev.y) / 6;
    if (n.type === 'hairpin') { tx *= 2.0; ty *= 2.0; }
    else if (n.type === 'chicane') { tx *= 0.3; ty *= 0.3; }
    else if (n.type === 'medium') { tx *= 1.2; ty *= 1.2; }
    else if (n.type === 'high') { tx *= 0.8; ty *= 0.8; }
    const sharpFactor = 1.0 - ((n.sharpness || 0) / 200);
    tx *= sharpFactor; ty *= sharpFactor;
    const pIn = n.cpIn ? { x: n.x + n.cpIn.x, y: n.y + n.cpIn.y } : { x: n.x - tx, y: n.y - ty };
    const pOut = n.cpOut ? { x: n.x + n.cpOut.x, y: n.y + n.cpOut.y } : { x: n.x + tx, y: n.y + ty };
    return { pIn, pOut };
}

function bezierPoint(t, p0, c0, c1, p1) {
    const mt = 1 - t, mt2 = mt * mt, mt3 = mt2 * mt, t2 = t * t, t3 = t2 * t;
    return {
        x: p0.x * mt3 + 3 * c0.x * mt2 * t + 3 * c1.x * mt * t2 + p1.x * t3,
        y: p0.y * mt3 + 3 * c0.y * mt2 * t + 3 * c1.y * mt * t2 + p1.y * t3,
    };
}

/** Build a dense centerline polyline with cumulative arc-length. */
function buildCenterline(nodes, isClosed) {
    const pts = [];
    const len = nodes.length;
    const endLoop = isClosed ? len : len - 1;
    for (let i = 0; i < endLoop; i++) {
        const p1 = nodes[i];
        const p2 = nodes[(i + 1) % len];
        const c1 = getCtrlPts(nodes, isClosed, i).pOut;
        const c2 = getCtrlPts(nodes, isClosed, (i + 1) % len).pIn;
        for (let s = 0; s < SAMPLES_PER_SEG; s++) {
            pts.push(bezierPoint(s / SAMPLES_PER_SEG, p1, c1, c2, p2));
        }
    }
    if (isClosed && nodes.length) pts.push({ ...pts[0] });
    else if (nodes.length) pts.push({ ...nodes[nodes.length - 1] });

    // Cumulative arc length
    let total = 0;
    pts[0].d = 0;
    for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        pts[i].d = total;
    }
    return { pts, total };
}

// How fast each corner type lets a car go, as a fraction of top speed.
// Used as a hard cap on top of the geometric (curvature) limit so a node
// flagged as a chicane/hairpin is always taken slowly even if the spline
// between it and its neighbours happens to look gentle.
const TYPE_SPEED_CAP = {
    straight: 1.00,
    high: 0.82,     // fast, flowing corner
    medium: 0.58,
    chicane: 0.40,  // tight left-right flick — heavy braking
    hairpin: 0.26,  // slowest corner on the track
};

/**
 * Build a per-point speed limit (world units / second) along the centerline.
 *
 * Physics model:
 *   • Cornering limit  v = sqrt(aLat * r)  — a car can only carry so much
 *     speed through a corner of radius r before lateral grip runs out.
 *   • Type cap         — chicanes/hairpins are clamped low regardless of r.
 *   • Braking pass     — backwards sweep so a car slows DOWN in time for a
 *     corner instead of braking instantly at the apex.
 *   • Acceleration pass— forwards sweep so it powers back up out of a corner.
 *
 * Everything self-scales off the track's size so it works for any layout.
 */
function buildSpeedProfile(line, nodes, isClosed, carClass) {
    const pts = line.pts;
    const n = pts.length;
    const topSpeed = 150 * carClass.speed;        // world units / second
    if (n < 3) return new Array(n).fill(topSpeed);

    // Track scale → reference radius / braking distance (geometry-independent).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const diag = Math.hypot(maxX - minX, maxY - minY) || 1;
    // A corner whose radius is >= rFull can be taken flat out. Higher-grip
    // cars (F1) get a smaller rFull, so they carry more speed through bends.
    const rFull = (diag * 0.085) / (carClass.grip || 1);
    const aLat = (topSpeed * topSpeed) / rFull;   // lateral accel budget
    const brakeDist = diag * 0.06;                // wu to wash off top speed
    const aBrake = (topSpeed * topSpeed) / (2 * brakeDist);
    const aAccel = aBrake * 0.55;                 // power-down < grip-down

    // Nearest-node type cap, sampled per centerline point.
    const segPts = SAMPLES_PER_SEG;
    const typeCapAt = (i) => {
        const nodeIdx = Math.round(i / segPts) % Math.max(nodes.length, 1);
        const node = nodes[nodeIdx];
        if (!node) return 1;
        let cap = TYPE_SPEED_CAP[node.type] ?? 1;
        // Sharper corners (slider) shave a little more off.
        cap *= 1 - (node.sharpness || 0) / 260;
        return Math.max(0.18, cap);
    };

    const v = new Array(n);
    for (let i = 0; i < n; i++) {
        const a = pts[(i - 1 + n) % n];
        const b = pts[i];
        const c = pts[(i + 1) % n];
        // Circumradius of the three consecutive points.
        const ab = Math.hypot(b.x - a.x, b.y - a.y);
        const bc = Math.hypot(c.x - b.x, c.y - b.y);
        const ca = Math.hypot(a.x - c.x, a.y - c.y);
        const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * 0.5;
        let r = area > 1e-6 ? (ab * bc * ca) / (4 * area) : Infinity;
        const vCorner = isFinite(r) ? Math.sqrt(aLat * r) : topSpeed;
        v[i] = Math.min(topSpeed, vCorner, topSpeed * typeCapAt(i));
    }

    const ds = (i, j) => Math.max(Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y), 1e-3);

    // Braking pass (backwards). Two sweeps on closed tracks so the limit
    // wraps cleanly across the start/finish line.
    const sweeps = isClosed ? 2 : 1;
    for (let s = 0; s < sweeps; s++) {
        for (let i = n - 2; i >= 0; i--) {
            const next = isClosed ? (i + 1) % n : i + 1;
            const allow = Math.sqrt(v[next] * v[next] + 2 * aBrake * ds(i, next));
            if (allow < v[i]) v[i] = allow;
        }
        if (isClosed) {
            const allow = Math.sqrt(v[0] * v[0] + 2 * aBrake * ds(n - 1, 0));
            if (allow < v[n - 1]) v[n - 1] = allow;
        }
    }
    // Acceleration pass (forwards).
    for (let s = 0; s < sweeps; s++) {
        for (let i = 1; i < n; i++) {
            const prev = i - 1;
            const allow = Math.sqrt(v[prev] * v[prev] + 2 * aAccel * ds(prev, i));
            if (allow < v[i]) v[i] = allow;
        }
        if (isClosed) {
            const allow = Math.sqrt(v[n - 1] * v[n - 1] + 2 * aAccel * ds(n - 1, 0));
            if (allow < v[0]) v[0] = allow;
        }
    }
    return v;
}

/** Look up the speed limit (world units/sec) at arc-length `dist`. */
function speedLimitAt(line, profile, dist) {
    const { pts, total } = line;
    if (total <= 0 || !profile.length) return profile[0] || 0;
    let d = dist;
    if (d < 0) d = 0;
    if (d > total) d = total;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].d < d) lo = mid; else hi = mid;
    }
    const seg = (pts[hi].d - pts[lo].d) || 1;
    const f = (d - pts[lo].d) / seg;
    return profile[lo] + (profile[hi] - profile[lo]) * f;
}

/** Position + heading at arc-length `dist` along the centerline. */
function sampleAt(line, dist) {
    const { pts, total } = line;
    if (total <= 0) return { x: pts[0].x, y: pts[0].y, angle: 0 };
    let d = dist;
    if (d < 0) d = 0;
    if (d > total) d = total;
    // binary search the segment
    let lo = 0, hi = pts.length - 1;
    while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].d < d) lo = mid; else hi = mid;
    }
    const a = pts[lo], b = pts[hi];
    const seg = (b.d - a.d) || 1;
    const f = (d - a.d) / seg;
    return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
}

// ── Loading ──────────────────────────────────────────────────────────────
function loadProject(id) {
    let raw = null;
    try {
        if (window.ApexNativeBridge && window.ApexNativeBridge.getItem) {
            raw = window.ApexNativeBridge.getItem(STORAGE_KEY);
        }
    } catch (e) { /* ignore */ }
    if (!raw) { try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) {} }
    if (!raw) return null;
    let projects;
    try { projects = JSON.parse(raw); } catch (e) { return null; }
    if (!Array.isArray(projects)) return null;
    if (id) return projects.find(p => p.id === id) || null;
    // Fallback: most recently modified
    return projects.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))[0] || null;
}

const MIN_TRACK_WIDTH = 12;

// ── Racer ─────────────────────────────────────────────────────────────────
class TrackRacer {
    constructor(canvas, project) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.project = project;
        const data = project.data || {};
        this.isClosed = !!data.isClosedTrack;
        this.carClass = resolveCarClass();
        this.scaleUnit = data.scaleUnit || 'km';
        this.pxPerUnit = parseFloat(data.pxPerUnit) || 100;
        this.trackWidth = Math.max(MIN_TRACK_WIDTH, parseFloat(data.trackWidth) || 36);

        this.nodes = (data.nodes || []).map(n => ({
            x: n.x, y: n.y, sharpness: n.sharpness || 0, type: n.type || 'straight',
            cpIn: n.cpIn ? { x: n.cpIn.x, y: n.cpIn.y } : null,
            cpOut: n.cpOut ? { x: n.cpOut.x, y: n.cpOut.y } : null,
            isDRS: !!n.isDRS, sector: n.sector || 1,
            customWidth: (n.customWidth !== undefined && n.customWidth !== null) ? Math.max(MIN_TRACK_WIDTH, parseFloat(n.customWidth)) : null,
            isTransition: !!n.isTransition,
        }));

        this.line = buildCenterline(this.nodes, this.isClosed);
        this.computeBounds();

        // Per-point speed limit so cars brake for corners and chicanes.
        this.speedProfile = buildSpeedProfile(this.line, this.nodes, this.isClosed, this.carClass);
        const baseSpeed = 150 * this.carClass.speed; // world units / second (top speed)
        this.topSpeed = baseSpeed;
        this.kmhPerWU = (this.carClass.topKmh || 250) / baseSpeed;

        // Cars: hero (player) + two rivals. `skill` scales each car's pace;
        // `speed` is the instantaneous speed, recomputed every frame from the
        // track's speed profile (slow in corners, fast on straights).
        this.cars = [
            { name: 'YOU', isHero: true, dist: 0, skill: 1.00, speed: baseSpeed, color: this.carClass.body, lap: 0 },
            { name: 'AI-2', isHero: false, dist: -this.carClass.length * 1.4, skill: 0.975, speed: baseSpeed, color: '#94a3b8', lap: 0 },
            { name: 'AI-3', isHero: false, dist: -this.carClass.length * 2.8, skill: 0.96, speed: baseSpeed, color: '#475569', lap: 0 },
        ];
        this.startTime = null;
        this.lastT = null;
        this.running = true;

        this.fitView();
        this.initControls();
        this.updateHUDMeta();
        window.addEventListener('resize', () => { this.resize(); });
        this.resize();
    }

    getNodeWidths() {
        const len = this.nodes.length;
        if (len === 0) return [];
        const baseWidth = Math.max(MIN_TRACK_WIDTH, this.trackWidth || 36);

        const fixedIndices = [];
        for (let i = 0; i < len; i++) {
            const n = this.nodes[i];
            if (n.customWidth !== null && n.customWidth !== undefined && !n.isTransition) {
                fixedIndices.push(i);
            }
        }

        if (fixedIndices.length === 0) {
            return this.nodes.map(() => baseWidth);
        }

        if (fixedIndices.length === 1) {
            const singleW = Math.max(MIN_TRACK_WIDTH, this.nodes[fixedIndices[0]].customWidth);
            return this.nodes.map(() => singleW);
        }

        const resolved = new Array(len);

        if (this.isClosed) {
            for (let f = 0; f < fixedIndices.length; f++) {
                const idxA = fixedIndices[f];
                const idxB = fixedIndices[(f + 1) % fixedIndices.length];
                const wA = Math.max(MIN_TRACK_WIDTH, this.nodes[idxA].customWidth);
                const wB = Math.max(MIN_TRACK_WIDTH, this.nodes[idxB].customWidth);

                let spanCount = (idxB - idxA + len) % len;
                if (spanCount === 0) spanCount = len;

                resolved[idxA] = wA;
                for (let step = 1; step < spanCount; step++) {
                    const curIdx = (idxA + step) % len;
                    const ratio = step / spanCount;
                    const smoothRatio = ratio * ratio * (3 - 2 * ratio);
                    resolved[curIdx] = Math.max(MIN_TRACK_WIDTH, wA + (wB - wA) * smoothRatio);
                }
            }
        } else {
            const firstIdx = fixedIndices[0];
            const lastIdx = fixedIndices[fixedIndices.length - 1];

            for (let i = 0; i <= firstIdx; i++) {
                resolved[i] = Math.max(MIN_TRACK_WIDTH, this.nodes[firstIdx].customWidth);
            }
            for (let i = lastIdx; i < len; i++) {
                resolved[i] = Math.max(MIN_TRACK_WIDTH, this.nodes[lastIdx].customWidth);
            }

            for (let f = 0; f < fixedIndices.length - 1; f++) {
                const idxA = fixedIndices[f];
                const idxB = fixedIndices[f + 1];
                const wA = Math.max(MIN_TRACK_WIDTH, this.nodes[idxA].customWidth);
                const wB = Math.max(MIN_TRACK_WIDTH, this.nodes[idxB].customWidth);
                const spanCount = idxB - idxA;

                for (let step = 0; step <= spanCount; step++) {
                    const curIdx = idxA + step;
                    const ratio = spanCount > 0 ? (step / spanCount) : 0;
                    const smoothRatio = ratio * ratio * (3 - 2 * ratio);
                    resolved[curIdx] = Math.max(MIN_TRACK_WIDTH, wA + (wB - wA) * smoothRatio);
                }
            }
        }

        return resolved;
    }

    getWidthAt(nodeIdx, t = 0) {
        const widths = this.getNodeWidths();
        if (!widths.length) return Math.max(MIN_TRACK_WIDTH, this.trackWidth || 36);
        const len = this.nodes.length;
        const nextIdx = (nodeIdx + 1) % len;
        const w1 = widths[nodeIdx];
        const w2 = widths[nextIdx];
        const smoothT = t * t * (3 - 2 * t);
        return Math.max(MIN_TRACK_WIDTH, w1 + (w2 - w1) * smoothT);
    }

    getPhysicalLength() {
        if (!this.line || !this.line.total) return 0;
        const totalUnits = this.line.total / this.pxPerUnit;
        return totalUnits;
    }

    updateHUDMeta() {
        const widthEl = document.getElementById('hud-width');
        const lengthEl = document.getElementById('hud-length');
        const lengthUnitLabel = document.getElementById('race-length-unit-label');
        const lengthInput = document.getElementById('race-length-input');
        const widthInput = document.getElementById('race-width-input');
        const widthSlider = document.getElementById('race-width-slider');

        const physicalLen = this.getPhysicalLength();
        if (widthEl) widthEl.textContent = `${Math.round(this.trackWidth)} PX`;
        if (lengthEl) lengthEl.textContent = `${physicalLen.toFixed(2)} ${this.scaleUnit.toUpperCase()}`;
        if (lengthUnitLabel) lengthUnitLabel.textContent = this.scaleUnit.toUpperCase();
        if (lengthInput && document.activeElement !== lengthInput) lengthInput.value = physicalLen.toFixed(2);
        if (widthInput && document.activeElement !== widthInput) widthInput.value = Math.round(this.trackWidth).toString();
        if (widthSlider && document.activeElement !== widthSlider) widthSlider.value = Math.round(this.trackWidth).toString();
    }

    setTrackWidth(val) {
        let num = parseFloat(val);
        const warn = document.getElementById('race-width-min-warn');
        if (isNaN(num) || num < MIN_TRACK_WIDTH) {
            num = MIN_TRACK_WIDTH;
            if (warn) warn.classList.add('show');
        } else {
            if (warn) warn.classList.remove('show');
        }
        this.trackWidth = num;
        this.fitView();
        this.updateHUDMeta();
        this.saveCurrentProject();
    }

    setTrackLength(targetVal) {
        const parsed = parseFloat(targetVal);
        if (isNaN(parsed) || parsed <= 0 || this.nodes.length < 2) return;

        const currentPhysical = this.getPhysicalLength();
        if (currentPhysical <= 0) return;

        const ratio = parsed / currentPhysical;
        if (ratio <= 0 || !isFinite(ratio)) return;

        // Scale nodes relative to bounding center
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of this.nodes) {
            if (n.x < minX) minX = n.x; if (n.x > maxX) maxX = n.x;
            if (n.y < minY) minY = n.y; if (n.y > maxY) maxY = n.y;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;

        for (const n of this.nodes) {
            n.x = cx + (n.x - cx) * ratio;
            n.y = cy + (n.y - cy) * ratio;
            if (n.cpIn) { n.cpIn.x *= ratio; n.cpIn.y *= ratio; }
            if (n.cpOut) { n.cpOut.x *= ratio; n.cpOut.y *= ratio; }
        }

        this.line = buildCenterline(this.nodes, this.isClosed);
        this.computeBounds();
        this.speedProfile = buildSpeedProfile(this.line, this.nodes, this.isClosed, this.carClass);
        this.fitView();
        this.updateHUDMeta();
        this.saveCurrentProject();
    }

    saveCurrentProject() {
        if (!this.project || !this.project.id) return;
        try {
            const raw = (window.ApexNativeBridge && window.ApexNativeBridge.getItem)
                ? window.ApexNativeBridge.getItem(STORAGE_KEY)
                : localStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            const projects = JSON.parse(raw);
            const idx = projects.findIndex(p => p.id === this.project.id);
            if (idx >= 0) {
                projects[idx].data = projects[idx].data || {};
                projects[idx].data.trackWidth = this.trackWidth;
                projects[idx].data.nodes = this.nodes;
                projects[idx].lastModified = Date.now();
                const str = JSON.stringify(projects);
                if (window.ApexNativeBridge && window.ApexNativeBridge.setItem) {
                    window.ApexNativeBridge.setItem(STORAGE_KEY, str);
                } else {
                    localStorage.setItem(STORAGE_KEY, str);
                }
            }
        } catch (e) {
            console.warn('[Race] Could not save project modifications:', e);
        }
    }

    initControls() {
        const slider = document.getElementById('race-width-slider');
        const widthInput = document.getElementById('race-width-input');
        const lengthInput = document.getElementById('race-length-input');
        const applyBtn = document.getElementById('race-apply-length-btn');
        const toggleBtn = document.getElementById('toggle-tuning-btn');
        const panel = document.getElementById('race-tuning-panel');

        slider?.addEventListener('input', (e) => {
            this.setTrackWidth(e.target.value);
        });
        widthInput?.addEventListener('change', (e) => {
            this.setTrackWidth(e.target.value);
        });
        applyBtn?.addEventListener('click', () => {
            if (lengthInput) this.setTrackLength(lengthInput.value);
        });
        lengthInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                this.setTrackLength(e.target.value);
            }
        });
        toggleBtn?.addEventListener('click', () => {
            if (panel) {
                const isHidden = panel.style.display === 'none';
                panel.style.display = isHidden ? 'flex' : 'none';
                toggleBtn.querySelector('span').textContent = isHidden ? 'Hide Tuner' : 'Tune Track Dimensions';
            }
        });
    }

    computeBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of this.line.pts) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
        this.bounds = { minX, minY, maxX, maxY };
    }

    resize() {
        const ratio = window.devicePixelRatio || 1;
        this.canvas.width = window.innerWidth * ratio;
        this.canvas.height = window.innerHeight * ratio;
        this.canvas.style.width = window.innerWidth + 'px';
        this.canvas.style.height = window.innerHeight + 'px';
        this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        this.viewW = window.innerWidth;
        this.viewH = window.innerHeight;
        this.fitView();
    }

    fitView() {
        const pad = this.trackWidth * 1.5 + 60;
        const b = this.bounds;
        const w = (b.maxX - b.minX) || 1;
        const h = (b.maxY - b.minY) || 1;
        const vw = this.viewW || window.innerWidth;
        const vh = this.viewH || window.innerHeight;
        const scale = Math.min((vw - pad * 2) / w, (vh - pad * 2) / h);
        this.scale = scale > 0 ? scale : 1;
        this.offsetX = (vw - w * this.scale) / 2 - b.minX * this.scale;
        this.offsetY = (vh - h * this.scale) / 2 - b.minY * this.scale;
    }

    w2s(x, y) {
        return { x: x * this.scale + this.offsetX, y: y * this.scale + this.offsetY };
    }

    start() {
        const loop = (ts) => {
            if (!this.running) return;
            if (this.startTime === null) { this.startTime = ts; this.lastT = ts; }
            const dt = Math.min((ts - this.lastT) / 1000, 0.05);
            this.lastT = ts;
            this.update(dt);
            this.draw(ts);
            requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
    }

    update(dt) {
        const total = this.line.total;
        for (const car of this.cars) {
            // Target speed at this point on the track (already accounts for
            // braking zones and corner exits), scaled by the car's skill.
            const limit = speedLimitAt(this.line, this.speedProfile, car.dist) * car.skill;
            // Ease toward the target so transitions look like real throttle/
            // brake rather than instant speed changes.
            const rate = limit < car.speed ? 6 : 3; // brake harder than we accelerate
            car.speed += (limit - car.speed) * Math.min(1, rate * dt);
            car.dist += car.speed * dt;
            if (total > 0) {
                while (car.dist >= total) {
                    car.dist -= total;
                    car.lap += 1;
                    if (!this.isClosed) car.dist = 0; // point-to-point: restart from grid
                }
            }
        }
        const hero = this.cars.find(c => c.isHero);
        const speedEl = document.getElementById('hud-speed');
        if (speedEl) {
            // Real speed: the hero's actual world speed mapped to km/h.
            const kmh = Math.max(0, Math.round(hero.speed * this.kmhPerWU));
            speedEl.textContent = kmh + ' km/h';
        }
        const lapEl = document.getElementById('hud-lap');
        if (lapEl) lapEl.textContent = this.isClosed ? ('LAP ' + (hero.lap + 1)) : 'STAGE RUN';
    }

    draw(ts) {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.viewW, this.viewH);
        this.drawTrack(ctx);
        this.drawStartFinish(ctx);
        // Draw rivals first, hero on top
        const ordered = [...this.cars].sort((a, b) => (a.isHero ? 1 : 0) - (b.isHero ? 1 : 0));
        for (const car of ordered) this.drawCar(ctx, car);
    }

    strokeCenterline(ctx, widthWorld) {
        const pts = this.line.pts;
        ctx.beginPath();
        for (let i = 0; i < pts.length; i++) {
            const s = this.w2s(pts[i].x, pts[i].y);
            if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
        }
        ctx.lineWidth = widthWorld * this.scale;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
    }

    strokeCenterlineVariable(ctx, widthOffset) {
        const pts = this.line.pts;
        const n = pts.length;
        if (n < 2) return;
        const len = this.nodes.length;
        const stepsPerSeg = SAMPLES_PER_SEG;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (let i = 0; i < n - 1; i++) {
            const s1 = this.w2s(pts[i].x, pts[i].y);
            const s2 = this.w2s(pts[i + 1].x, pts[i + 1].y);
            const segIdx = Math.min(len - 1, Math.floor(i / stepsPerSeg));
            const t = (i % stepsPerSeg) / stepsPerSeg;
            const localW = this.getWidthAt(segIdx, t);
            const totalW = Math.max(2, (localW + widthOffset) * this.scale);

            ctx.lineWidth = totalW;
            ctx.beginPath();
            ctx.moveTo(s1.x, s1.y);
            ctx.lineTo(s2.x, s2.y);
            ctx.stroke();
        }
    }

    drawTrack(ctx) {
        // Run-off / kerb halo
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        this.strokeCenterlineVariable(ctx, 14);
        // Kerb edge
        ctx.strokeStyle = this.carClass.accent + '55';
        this.strokeCenterlineVariable(ctx, 6);
        // Asphalt
        ctx.strokeStyle = '#23272e';
        this.strokeCenterlineVariable(ctx, 0);
        // Centre racing line (dashed)
        ctx.save();
        ctx.setLineDash([16, 22]);
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        this.strokeCenterline(ctx, 1.6);
        ctx.restore();
    }

    drawStartFinish(ctx) {
        const pts = this.line.pts;
        if (pts.length < 2) return;
        const a = pts[0], b = pts[1];
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const s = this.w2s(a.x, a.y);
        const startW = this.getWidthAt(0, 0);
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(ang + Math.PI / 2);
        const halfW = (startW / 2) * this.scale;
        const cell = Math.max(4, halfW / 3);
        ctx.fillStyle = '#fff';
        for (let row = 0; row < 2; row++) {
            for (let x = -halfW; x < halfW; x += cell) {
                const onWhite = (Math.floor((x + halfW) / cell) + row) % 2 === 0;
                if (onWhite) ctx.fillRect(x, row * cell - cell, cell, cell);
            }
        }
        ctx.restore();
    }

    drawCar(ctx, car) {
        const pos = sampleAt(this.line, car.dist);
        const s = this.w2s(pos.x, pos.y);
        const L = this.carClass.length * this.scale;
        const W = this.carClass.width * this.scale;
        ctx.save();
        ctx.translate(s.x, s.y);
        ctx.rotate(pos.angle);

        // Shadow
        ctx.save();
        ctx.translate(L * 0.06, W * 0.16);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        this.carPath(ctx, L, W);
        ctx.fill();
        ctx.restore();

        const body = car.isHero ? this.carClass.body : car.color;
        this.paintBody(ctx, L, W, body, car.isHero);

        ctx.restore();

        // Hero name tag
        if (car.isHero) {
            ctx.save();
            ctx.font = '700 11px Orbitron, sans-serif';
            ctx.fillStyle = this.carClass.accent;
            ctx.textAlign = 'center';
            ctx.fillText(this.carClass.label.toUpperCase(), s.x, s.y - W - 8);
            ctx.restore();
        }
    }

    carPath(ctx, L, W) {
        // Rounded-rect body centred at origin, nose pointing +x
        const r = Math.min(L, W) * 0.28;
        const hl = L / 2, hw = W / 2;
        ctx.beginPath();
        ctx.moveTo(-hl + r, -hw);
        ctx.lineTo(hl - r, -hw);
        ctx.quadraticCurveTo(hl, -hw, hl, -hw + r);
        ctx.lineTo(hl, hw - r);
        ctx.quadraticCurveTo(hl, hw, hl - r, hw);
        ctx.lineTo(-hl + r, hw);
        ctx.quadraticCurveTo(-hl, hw, -hl, hw - r);
        ctx.lineTo(-hl, -hw + r);
        ctx.quadraticCurveTo(-hl, -hw, -hl + r, -hw);
        ctx.closePath();
    }

    paintBody(ctx, L, W, body, isHero) {
        const hl = L / 2, hw = W / 2;
        const detail = this.carClass.detail;

        // tyres
        ctx.fillStyle = '#0a0a0a';
        ctx.fillRect(-hl * 0.55, -hw - 3, hl * 0.30, 4);
        ctx.fillRect(-hl * 0.55, hw - 1, hl * 0.30, 4);
        ctx.fillRect(hl * 0.30, -hw - 3, hl * 0.30, 4);
        ctx.fillRect(hl * 0.30, hw - 1, hl * 0.30, 4);
        // narrow body
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.moveTo(hl, 0);
        ctx.lineTo(hl * 0.4, -hw * 0.45);
        ctx.lineTo(-hl * 0.7, -hw * 0.5);
        ctx.lineTo(-hl, -hw * 0.9);
        ctx.lineTo(-hl, hw * 0.9);
        ctx.lineTo(-hl * 0.7, hw * 0.5);
        ctx.lineTo(hl * 0.4, hw * 0.45);
        ctx.closePath();
        ctx.fill();
        // front wing
        ctx.fillStyle = detail;
        ctx.fillRect(hl - 2, -hw, 3, W);
        // cockpit
        ctx.fillStyle = detail;
        ctx.beginPath();
        ctx.ellipse(-hl * 0.1, 0, L * 0.10, W * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
    }
}

// ── Boot ───────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const project = loadProject(id);
    const canvas = document.getElementById('race-canvas');
    const overlay = document.getElementById('race-error');

    if (!project || !project.data || !Array.isArray(project.data.nodes) || project.data.nodes.length < 2) {
        if (overlay) overlay.classList.remove('hidden');
        return;
    }

    document.getElementById('hud-track-name').textContent = (project.name || 'Untitled Circuit').toUpperCase();
    const racer = new TrackRacer(canvas, project);
    document.getElementById('hud-class').textContent = racer.carClass.label.toUpperCase();
    document.getElementById('hud-class').style.color = racer.carClass.accent;
    racer.start();
});
