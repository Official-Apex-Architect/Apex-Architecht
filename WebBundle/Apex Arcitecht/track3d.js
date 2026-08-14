"use strict";
/**
 * Apex Architect — 3D Elevation Viewer + Editor (BETA)
 * Beta feature for all-access ("best deal") members only.
 *
 * Viewer: rebuilds the editor's bezier centerline, lifts each point by its
 * per-node elevation, and renders a 3D road ribbon with a height gradient.
 *
 * Editor: click the track surface to drop a new point ON the track path,
 * select any point and change its height with a slider. Changes are saved
 * back into the same project store the 2D designer reads.
 */

const STORAGE_KEY = 'apex_projects_v1';
const TRACK_WIDTH = 36;        // world units, matches the editor's main road
const HALF_WIDTH = TRACK_WIDTH / 2;
const SAMPLES_PER_SEG = 40;    // bezier subdivisions per segment

// ── Geometry (ported 1:1 from the editor) ──────────────────────────────────
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

function resolveNodeElevations(nodes, isClosed) {
    const resolved = nodes.map(node => node.elevation || 0);
    const findFixedPoint = (startIndex, direction) => {
        for (let distance = 1; distance < nodes.length; distance++) {
            let index = startIndex + distance * direction;
            if (!isClosed && (index < 0 || index >= nodes.length)) return null;
            index = (index + nodes.length) % nodes.length;
            if (!nodes[index].isElevationTransition) {
                return { index, distance, elevation: resolved[index] };
            }
        }
        return null;
    };

    nodes.forEach((node, index) => {
        if (!node.isElevationTransition) return;
        const previous = findFixedPoint(index, -1);
        const next = findFixedPoint(index, 1);
        if (!previous || !next || previous.index === next.index) return;
        const ratio = previous.distance / (previous.distance + next.distance);
        const smoothRatio = ratio * ratio * (3 - 2 * ratio);
        resolved[index] = previous.elevation + (next.elevation - previous.elevation) * smoothRatio;
    });
    return resolved;
}

/**
 * Build a dense centerline carrying interpolated elevation (metres) and the
 * source segment index `seg` (which node-to-node span each sample came from).
 * Returns { pts: [{x, y, elev, seg}], total }, x/y in editor-plane coords.
 */
function buildCenterline3D(nodes, isClosed) {
    const pts = [];
    const len = nodes.length;
    const endLoop = isClosed ? len : len - 1;
    const elevations = resolveNodeElevations(nodes, isClosed);
    for (let i = 0; i < endLoop; i++) {
        const p1 = nodes[i];
        const p2 = nodes[(i + 1) % len];
        const c1 = getCtrlPts(nodes, isClosed, i).pOut;
        const c2 = getCtrlPts(nodes, isClosed, (i + 1) % len).pIn;
        const e1 = elevations[i];
        const e2 = elevations[(i + 1) % len];
        for (let s = 0; s < SAMPLES_PER_SEG; s++) {
            const t = s / SAMPLES_PER_SEG;
            const b = bezierPoint(t, p1, c1, c2, p2);
            const tt = t * t * (3 - 2 * t); // smoothstep for natural crests/dips
            b.elev = e1 + (e2 - e1) * tt;
            b.seg = i;
            pts.push(b);
        }
    }
    if (isClosed && nodes.length) {
        pts.push({ x: pts[0].x, y: pts[0].y, elev: pts[0].elev, seg: endLoop - 1 });
    } else if (nodes.length) {
        const last = nodes[nodes.length - 1];
        pts.push({ x: last.x, y: last.y, elev: elevations[nodes.length - 1], seg: Math.max(0, endLoop - 1) });
    }
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }
    return { pts, total };
}

function readProjects() {
    let raw = null;
    try {
        if (window.ApexNativeBridge && window.ApexNativeBridge.getItem) raw = window.ApexNativeBridge.getItem(STORAGE_KEY);
    } catch (e) {}
    if (!raw) { try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) {} }
    if (!raw) return [];
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch (e) { return []; }
}

function writeProjects(projects) {
    const str = JSON.stringify(projects);
    const isQuota = (e) => e instanceof DOMException && (e.code === 22 || e.name === 'QuotaExceededError');
    try {
        if (window.ApexNativeBridge && window.ApexNativeBridge.setItem) {
            window.ApexNativeBridge.setItem(STORAGE_KEY, str);
            return true;
        }
    } catch (e) {
        if (isQuota(e)) { alert('Storage full — delete older projects to free space.'); return false; }
    }
    try { localStorage.setItem(STORAGE_KEY, str); return true; } catch (e) {
        if (isQuota(e)) { alert('Storage full — delete older projects to free space.'); }
        return false;
    }
}

function loadProject(id) {
    const projects = readProjects();
    if (id) return projects.find(p => p.id === id) || null;
    return projects.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))[0] || null;
}

// height -> RGB gradient (blue low → green mid → red high)
function heightColor(t) {
    let r, g, b;
    if (t < 0.5) {
        const k = t / 0.5;
        r = 0.15 + (0.13 - 0.15) * k; g = 0.40 + (0.77 - 0.40) * k; b = 0.92 + (0.30 - 0.92) * k;
    } else {
        const k = (t - 0.5) / 0.5;
        r = 0.13 + (0.94 - 0.13) * k; g = 0.77 + (0.27 - 0.77) * k; b = 0.30 + (0.20 - 0.30) * k;
    }
    return [r, g, b];
}

function cloneNode(n) {
    return {
        x: n.x, y: n.y,
        sharpness: n.sharpness || 0,
        sector: n.sector || 1,
        isDRS: !!n.isDRS,
        type: n.type || 'straight',
        turnNumber: n.turnNumber || 0,
        elevation: n.elevation || 0,
        isElevationTransition: !!n.isElevationTransition,
        customWidth: (n.customWidth !== undefined && n.customWidth !== null) ? Math.max(12, parseFloat(n.customWidth)) : null,
        isTransition: !!n.isTransition,
        cpIn: n.cpIn ? { x: n.cpIn.x, y: n.cpIn.y } : null,
        cpOut: n.cpOut ? { x: n.cpOut.x, y: n.cpOut.y } : null,
    };
}

// ── 3D Viewer + Editor ───────────────────────────────────────────────────────
class Track3DViewer {
    constructor(project) {
        const data = project.data || {};
        this.project = project;
        this.projectId = project.id;
        this.isClosed = !!data.isClosedTrack;
        this.trackWidth = Math.max(12, parseFloat(data.trackWidth) || 36);
        this.halfWidth = this.trackWidth / 2;
        // Keep full node objects so edits can be saved back intact.
        this.nodes = (data.nodes || []).map(cloneNode);

        this.exaggeration = 1.0;
        this.editMode = false;
        this.selectedNodeIndex = -1;
        this.nodeMarkers = [];
        this.saveTimer = null;

        this.recomputeLine();
        this.computeFraming(); // center/size fixed for the session (stable camera)
        this.heightPerMeter = this.size * 0.0016;

        this.azimuth = Math.PI * 0.25;
        this.polar = Math.PI * 0.34;
        this.radius = this.size * 1.5;
        this.autoRotate = true;
        // Orbit/look-at center. Ctrl/⌘ + drag pans this through 3D space.
        this.target = new THREE.Vector3(0, this.size * 0.04, 0);
        this.markerR = Math.max(this.size * 0.012, this.trackWidth * 0.45);

        this.raycaster = new THREE.Raycaster();

        this.initThree();
        this.rebuildVisual();
        this.bindControls();
        this.animate = this.animate.bind(this);
        requestAnimationFrame(this.animate);
    }

    getNodeWidths() {
        const len = this.nodes.length;
        if (len === 0) return [];
        const baseWidth = Math.max(12, this.trackWidth || 36);

        const fixedIndices = [];
        for (let i = 0; i < len; i++) {
            const n = this.nodes[i];
            if (n.customWidth !== null && n.customWidth !== undefined && !n.isTransition) {
                fixedIndices.push(i);
            }
        }

        if (fixedIndices.length === 0) return this.nodes.map(() => baseWidth);
        if (fixedIndices.length === 1) {
            const singleW = Math.max(12, this.nodes[fixedIndices[0]].customWidth);
            return this.nodes.map(() => singleW);
        }

        const resolved = new Array(len);
        if (this.isClosed) {
            for (let f = 0; f < fixedIndices.length; f++) {
                const idxA = fixedIndices[f];
                const idxB = fixedIndices[(f + 1) % fixedIndices.length];
                const wA = Math.max(12, this.nodes[idxA].customWidth);
                const wB = Math.max(12, this.nodes[idxB].customWidth);

                let spanCount = (idxB - idxA + len) % len;
                if (spanCount === 0) spanCount = len;

                resolved[idxA] = wA;
                for (let step = 1; step < spanCount; step++) {
                    const curIdx = (idxA + step) % len;
                    const ratio = step / spanCount;
                    const smoothRatio = ratio * ratio * (3 - 2 * ratio);
                    resolved[curIdx] = Math.max(12, wA + (wB - wA) * smoothRatio);
                }
            }
        } else {
            const firstIdx = fixedIndices[0];
            const lastIdx = fixedIndices[fixedIndices.length - 1];

            for (let i = 0; i <= firstIdx; i++) resolved[i] = Math.max(12, this.nodes[firstIdx].customWidth);
            for (let i = lastIdx; i < len; i++) resolved[i] = Math.max(12, this.nodes[lastIdx].customWidth);

            for (let f = 0; f < fixedIndices.length - 1; f++) {
                const idxA = fixedIndices[f];
                const idxB = fixedIndices[f + 1];
                const wA = Math.max(12, this.nodes[idxA].customWidth);
                const wB = Math.max(12, this.nodes[idxB].customWidth);
                const spanCount = idxB - idxA;

                for (let step = 0; step <= spanCount; step++) {
                    const curIdx = idxA + step;
                    const ratio = spanCount > 0 ? (step / spanCount) : 0;
                    const smoothRatio = ratio * ratio * (3 - 2 * ratio);
                    resolved[curIdx] = Math.max(12, wA + (wB - wA) * smoothRatio);
                }
            }
        }
        return resolved;
    }

    getWidthAt(nodeIdx, t = 0) {
        const widths = this.getNodeWidths();
        if (!widths.length) return Math.max(12, this.trackWidth || 36);
        const len = this.nodes.length;
        const nextIdx = (nodeIdx + 1) % len;
        const w1 = widths[nodeIdx];
        const w2 = widths[nextIdx];
        const smoothT = t * t * (3 - 2 * t);
        return Math.max(12, w1 + (w2 - w1) * smoothT);
    }

    recomputeLine() {
        this.line = buildCenterline3D(this.nodes, this.isClosed);
        let minE = Infinity, maxE = -Infinity;
        for (const elevation of resolveNodeElevations(this.nodes, this.isClosed)) {
            if (elevation < minE) minE = elevation;
            if (elevation > maxE) maxE = elevation;
        }
        if (!isFinite(minE)) { minE = 0; maxE = 0; }
        this.minElev = minE; this.maxElev = maxE;
    }

    computeFraming() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of this.line.pts) {
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
        }
        this.center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
        this.size = Math.max(maxX - minX, maxY - minY) || 500;
    }

    elevToY(elev) { return elev * this.heightPerMeter * this.exaggeration; }

    initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x070a10);
        this.scene.fog = new THREE.Fog(0x070a10, this.size * 1.8, this.size * 4.5);
        this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, this.size * 12);
        try {
            this.renderer = new THREE.WebGLRenderer({ antialias: true, canvas: document.getElementById('gl-canvas') });
        } catch (e) {
            const errEl = document.getElementById('viewer-error');
            const loadEl = document.getElementById('viewer-loading');
            if (loadEl) loadEl.classList.add('hidden');
            if (errEl) {
                errEl.querySelector('h1').textContent = 'WebGL Not Available';
                errEl.querySelector('p').textContent = 'Your browser or device does not support WebGL. Try a different browser.';
                errEl.classList.remove('hidden');
            }
            throw e;
        }
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(window.innerWidth, window.innerHeight);

        this.scene.add(new THREE.HemisphereLight(0xbcd4ff, 0x202830, 1.05));
        const dir = new THREE.DirectionalLight(0xffffff, 1.1);
        dir.position.set(this.size, this.size * 1.4, this.size * 0.6);
        this.scene.add(dir);

        const gridSize = this.size * 2.4;
        this.grid = new THREE.GridHelper(gridSize, 40, 0x1f2b3a, 0x141c28);
        this.grid.position.y = -0.5;
        this.scene.add(this.grid);

        window.addEventListener('resize', () => this.onResize());
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // Rebuild both road mesh and node markers (after geometry/elevation edits).
    rebuildVisual() {
        this.buildRoad();
        this.buildMarkers();
        this.refreshHudElev();
    }

    buildRoad() {
        if (this.trackGroup) {
            this.scene.remove(this.trackGroup);
            this.trackGroup.traverse(o => {
                if (o.geometry) { o.geometry.dispose(); }
                if (o.material) {
                    if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
                    else o.material.dispose();
                }
            });
            this.trackGroup = null;
        }
        this.trackGroup = new THREE.Group();

        const pts = this.line.pts;
        const n = pts.length;
        const cx = this.center.x, cy = this.center.y;
        const range = (this.maxElev - this.minElev) || 1;

        const verts = [], colors = [], leftPts = [], rightPts = [];
        for (let i = 0; i < n; i++) {
            const p = pts[i];
            const a = pts[i === 0 ? 0 : i - 1];
            const b = pts[i === n - 1 ? n - 1 : i + 1];
            let tx = b.x - a.x, tz = b.y - a.y;
            const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
            const nx = -tz, nz = tx;
            const wx = p.x - cx, wz = p.y - cy;
            const y = this.elevToY(p.elev);
            const segIdx = p.seg !== undefined ? p.seg : Math.min(this.nodes.length - 1, Math.floor(i / SAMPLES_PER_SEG));
            const t = (i % SAMPLES_PER_SEG) / SAMPLES_PER_SEG;
            const localHalfW = this.getWidthAt(segIdx, t) / 2;
            const lx = wx + nx * localHalfW, lz = wz + nz * localHalfW;
            const rx = wx - nx * localHalfW, rz = wz - nz * localHalfW;
            leftPts.push(new THREE.Vector3(lx, y, lz));
            rightPts.push(new THREE.Vector3(rx, y, rz));
            const elevT = (p.elev - this.minElev) / range;
            const col = heightColor(elevT);
            verts.push(lx, y, lz, rx, y, rz);
            colors.push(col[0], col[1], col[2], col[0], col[1], col[2]);
        }

        const indices = [];
        for (let i = 0; i < n - 1; i++) {
            const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
            indices.push(a, c, b, b, c, d);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        geo.setIndex(indices);
        geo.computeVertexNormals();
        this.roadMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
            vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, metalness: 0.05,
        }));
        this.trackGroup.add(this.roadMesh);

        const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 });
        this.trackGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(leftPts), edgeMat));
        this.trackGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(rightPts), edgeMat.clone()));

        const postMat = new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.18 });
        const postPts = [];
        const step = Math.max(1, Math.floor(n / 90));
        for (let i = 0; i < n; i += step) {
            const lp = leftPts[i], rp = rightPts[i];
            const mx = (lp.x + rp.x) / 2, mz = (lp.z + rp.z) / 2;
            postPts.push(new THREE.Vector3(mx, lp.y, mz), new THREE.Vector3(mx, 0, mz));
        }
        this.trackGroup.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(postPts), postMat));

        if (n > 1) {
            const sg = new THREE.Mesh(new THREE.BoxGeometry(this.trackWidth, 2.5, 5),
                new THREE.MeshStandardMaterial({ color: 0xffffff }));
            const s0 = leftPts[0], e0 = rightPts[0];
            sg.position.set((s0.x + e0.x) / 2, s0.y + 1.5, (s0.z + e0.z) / 2);
            sg.lookAt((s0.x + e0.x) / 2 + (rightPts[1].x - rightPts[0].x), s0.y + 1.5,
                (s0.z + e0.z) / 2 + (rightPts[1].z - rightPts[0].z));
            this.trackGroup.add(sg);
        }
        this.scene.add(this.trackGroup);
    }

    // One interactive sphere per node, used for selection in edit mode.
    buildMarkers() {
        if (this.markersGroup) {
            this.scene.remove(this.markersGroup);
            this.markersGroup.traverse(o => {
                if (o.geometry) o.geometry.dispose();
                if (o.material) {
                    if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
                    else o.material.dispose();
                }
            });
            this.markersGroup = null;
        }
        this.markersGroup = new THREE.Group();
        this.nodeMarkers = [];
        const cx = this.center.x, cy = this.center.y;
        const geo = new THREE.SphereGeometry(this.markerR, 16, 12);
        const elevations = resolveNodeElevations(this.nodes, this.isClosed);
        for (let i = 0; i < this.nodes.length; i++) {
            const node = this.nodes[i];
            const selected = i === this.selectedNodeIndex;
            const mat = new THREE.MeshStandardMaterial({
                color: selected ? 0xfacc15 : 0x22d3ee,
                emissive: selected ? 0xfacc15 : 0x0891b2,
                emissiveIntensity: selected ? 0.6 : 0.25,
            });
            const m = new THREE.Mesh(geo, mat);
            m.position.set(node.x - cx, this.elevToY(elevations[i]) + this.markerR * 0.8, node.y - cy);
            m.userData.index = i;
            this.markersGroup.add(m);
            this.nodeMarkers.push(m);
        }
        this.markersGroup.visible = this.editMode;
        this.scene.add(this.markersGroup);
    }

    refreshHudElev() {
        const delta = this.maxElev - this.minElev;
        const el = document.getElementById('hud-elev');
        if (el) el.textContent = delta > 0 ? `${this.minElev}m → ${this.maxElev}m  (Δ ${delta}m)` : 'Flat (no elevation set)';
    }

    // ── Editing ──────────────────────────────────────────────────────────────
    setEditMode(on) {
        this.editMode = on;
        if (on) this.autoRotate = false;
        if (this.markersGroup) this.markersGroup.visible = on;
        const panel = document.getElementById('edit-panel');
        if (panel) panel.classList.toggle('hidden', !on);
        const btn = document.getElementById('editmode-btn');
        if (btn) {
            btn.textContent = on ? 'Editing: On' : 'Edit Mode';
            btn.classList.toggle('btn-active', on);
        }
        this.syncAutoBtn();
        if (!on) this.selectNode(-1);
    }

    /** Convert a client-space click to normalized device coords. */
    ndcFromEvent(clientX, clientY) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        return new THREE.Vector2(
            ((clientX - rect.left) / rect.width) * 2 - 1,
            -((clientY - rect.top) / rect.height) * 2 + 1,
        );
    }

    handleEditClick(clientX, clientY) {
        const ndc = this.ndcFromEvent(clientX, clientY);
        this.raycaster.setFromCamera(ndc, this.camera);
        // 1) Selecting an existing point takes priority.
        const markerHit = this.raycaster.intersectObjects(this.nodeMarkers, false);
        if (markerHit.length) { this.selectNode(markerHit[0].object.userData.index); return; }
        // 2) Otherwise, clicking the road drops a new point ON the track.
        if (this.roadMesh) {
            const roadHit = this.raycaster.intersectObject(this.roadMesh, false);
            if (roadHit.length) this.addPointOnTrack(roadHit[0].point);
        }
    }

    addPointOnTrack(worldPoint) {
        // scene -> editor-plane coords
        const ex = worldPoint.x + this.center.x;
        const ey = worldPoint.z + this.center.y;
        // snap to nearest sample on the current centerline so it sits on the path
        const pts = this.line.pts;
        let best = -1, bd = Infinity;
        for (let i = 0; i < pts.length; i++) {
            const dx = pts[i].x - ex, dy = pts[i].y - ey;
            const d = dx * dx + dy * dy;
            if (d < bd) { bd = d; best = i; }
        }
        if (best < 0) return;
        const samp = pts[best];
        const newNode = cloneNode({ x: samp.x, y: samp.y, elevation: Math.round(samp.elev) });
        const insertAt = Math.min(samp.seg + 1, this.nodes.length);
        this.nodes.splice(insertAt, 0, newNode);
        this.selectedNodeIndex = insertAt;
        this.recomputeLine();
        this.rebuildVisual();
        this.syncSelectionUI();
        this.scheduleSave();
    }

    selectNode(idx) {
        this.selectedNodeIndex = idx;
        this.buildMarkers(); // recolor
        this.syncSelectionUI();
    }

    syncSelectionUI() {
        const idx = this.selectedNodeIndex;
        const slider = document.getElementById('node-height');
        const label = document.getElementById('node-height-val');
        const info = document.getElementById('node-info');
        const delBtn = document.getElementById('node-delete-btn');
        const has = idx >= 0 && idx < this.nodes.length;
        if (slider) slider.disabled = !has;
        if (delBtn) delBtn.disabled = !has;
        if (has) {
            const e = this.nodes[idx].elevation || 0;
            if (slider) slider.value = e.toString();
            if (label) label.textContent = (e > 0 ? '+' : '') + e + ' m';
            if (info) info.textContent = `Point ${idx + 1} of ${this.nodes.length} selected`;
        } else {
            if (label) label.textContent = '— m';
            if (info) info.textContent = 'Click a point to select, or click the track to add one';
        }
    }

    setSelectedHeight(v) {
        const idx = this.selectedNodeIndex;
        if (idx < 0 || idx >= this.nodes.length) return;
        this.nodes[idx].elevation = v;
        this.nodes[idx].isElevationTransition = false;
        const label = document.getElementById('node-height-val');
        if (label) label.textContent = (v > 0 ? '+' : '') + v + ' m';
        this.recomputeLine();
        this.rebuildVisual();
        this.scheduleSave();
    }

    deleteSelected() {
        const idx = this.selectedNodeIndex;
        if (idx < 0 || idx >= this.nodes.length) return;
        if (this.nodes.length <= 2) { this.flashStatus('Need at least 2 points', true); return; }
        this.nodes.splice(idx, 1);
        this.selectedNodeIndex = -1;
        this.recomputeLine();
        this.rebuildVisual();
        this.syncSelectionUI();
        this.scheduleSave();
    }

    scheduleSave() {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => this.saveBack(), 500);
    }

    saveBack() {
        const projects = readProjects();
        const idx = projects.findIndex(p => p.id === this.projectId);
        if (idx < 0) { this.flashStatus('Save failed', true); return; }
        projects[idx].data = projects[idx].data || {};
        projects[idx].data.nodes = this.nodes;
        projects[idx].lastModified = Date.now();
        const ok = writeProjects(projects);
        this.flashStatus(ok ? 'Saved' : 'Save failed', !ok);
    }

    flashStatus(msg, isError) {
        const el = document.getElementById('edit-status');
        if (!el) return;
        el.textContent = msg;
        el.style.color = isError ? '#fca5a5' : '#67e8f9';
        el.style.opacity = '1';
        clearTimeout(this._statusTimer);
        this._statusTimer = setTimeout(() => { el.style.opacity = '0'; }, 1600);
    }

    // ── Controls ───────────────────────────────────────────────────────────────
    // Pan the orbit target through 3D space (screen delta → world plane).
    panCamera(dx, dy) {
        this.camera.updateMatrixWorld();
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        const dist = this.camera.position.distanceTo(this.target);
        const targetDist = dist * Math.tan((this.camera.fov / 2) * Math.PI / 180);
        const ph = this.renderer.domElement.clientHeight || window.innerHeight;
        const panX = (2 * dx * targetDist) / ph;
        const panY = (2 * dy * targetDist) / ph;
        this.target.addScaledVector(right, -panX);
        this.target.addScaledVector(up, panY);
    }

    bindControls() {
        const dom = this.renderer.domElement;
        let dragging = false, mode = 'orbit', lastX = 0, lastY = 0, downX = 0, downY = 0;

        const onDown = (x, y, isPan) => {
            dragging = true;
            mode = isPan ? 'pan' : 'orbit';
            lastX = x; lastY = y; downX = x; downY = y;
            if (isPan) { this.autoRotate = false; this.syncAutoBtn(); }
        };
        const onMove = (x, y) => {
            if (!dragging) return;
            const dx = x - lastX, dy = y - lastY;
            if (mode === 'pan') {
                this.panCamera(dx, dy);
            } else {
                this.azimuth -= dx * 0.005;
                this.polar -= dy * 0.005;
                this.polar = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, this.polar));
            }
            lastX = x; lastY = y;
        };
        const onUp = (x, y) => {
            const wasClick = Math.hypot(x - downX, y - downY) < 6;
            const wasMode = mode;
            dragging = false;
            // A plain (non-pan) click in edit mode edits; pan-clicks never edit.
            if (wasClick && this.editMode && wasMode !== 'pan') this.handleEditClick(x, y);
            else if (!wasClick && wasMode === 'orbit') { this.autoRotate = false; this.syncAutoBtn(); }
        };

        dom.addEventListener('contextmenu', (e) => e.preventDefault());
        dom.addEventListener('mousedown', (e) => {
            const isPan = e.ctrlKey || e.metaKey;
            if (isPan) e.preventDefault();
            onDown(e.clientX, e.clientY, isPan);
        });
        window.addEventListener('mousemove', (e) => onMove(e.clientX, e.clientY));
        window.addEventListener('mouseup', (e) => onUp(e.clientX, e.clientY));
        dom.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.radius *= (1 + (e.deltaY > 0 ? 0.08 : -0.08));
            this.radius = Math.max(this.size * 0.4, Math.min(this.size * 6, this.radius));
        }, { passive: false });
        dom.addEventListener('touchstart', (e) => { if (e.touches[0]) onDown(e.touches[0].clientX, e.touches[0].clientY, e.touches.length >= 2); });
        dom.addEventListener('touchmove', (e) => { if (e.touches[0]) onMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
        dom.addEventListener('touchend', (e) => { const t = e.changedTouches[0]; if (t) onUp(t.clientX, t.clientY); });

        const exaggInput = document.getElementById('exagg-range');
        if (exaggInput) exaggInput.addEventListener('input', (e) => {
            this.exaggeration = parseFloat(e.target.value);
            document.getElementById('exagg-val').textContent = this.exaggeration.toFixed(1) + '×';
            this.rebuildVisual();
        });

        const autoBtn = document.getElementById('autorotate-btn');
        if (autoBtn) autoBtn.addEventListener('click', () => { this.autoRotate = !this.autoRotate; this.syncAutoBtn(); });

        const editBtn = document.getElementById('editmode-btn');
        if (editBtn) editBtn.addEventListener('click', () => this.setEditMode(!this.editMode));

        const heightSlider = document.getElementById('node-height');
        if (heightSlider) heightSlider.addEventListener('input', (e) => this.setSelectedHeight(parseInt(e.target.value, 10) || 0));

        const delBtn = document.getElementById('node-delete-btn');
        if (delBtn) delBtn.addEventListener('click', () => this.deleteSelected());

        this.syncSelectionUI();
    }

    syncAutoBtn() {
        const autoBtn = document.getElementById('autorotate-btn');
        if (autoBtn) autoBtn.textContent = this.autoRotate ? 'Auto-Rotate: On' : 'Auto-Rotate: Off';
    }

    animate() {
        if (this.autoRotate) this.azimuth += 0.0024;
        const r = this.radius;
        const sp = Math.sin(this.polar), cp = Math.cos(this.polar);
        this.camera.position.set(
            this.target.x + Math.sin(this.azimuth) * sp * r,
            this.target.y + cp * r,
            this.target.z + Math.cos(this.azimuth) * sp * r,
        );
        this.camera.lookAt(this.target);
        this.renderer.render(this.scene, this.camera);
        requestAnimationFrame(this.animate);
    }
}

// ── Boot with beta gating ────────────────────────────────────────────────────
async function waitForAuthBootstrap() {
    if (!window.supabase || !window.supabase.auth) return;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            const { data: { user } } = await window.supabase.auth.getUser();
            if (user) return;
        } catch (e) { return; }
        await new Promise(r => setTimeout(r, 150));
    }
}

async function boot() {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const errEl = document.getElementById('viewer-error');
    const lockEl = document.getElementById('viewer-locked');
    const loadingEl = document.getElementById('viewer-loading');

    await waitForAuthBootstrap();

    // Gate: all-access ("best deal") members only.
    let tier = null;
    try {
        if (window.ApexMembership) {
            const access = await ApexMembership.getAvailableTags();
            tier = access && access.tier;
        }
    } catch (e) {}

    if (tier !== 'all_access') {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (lockEl) lockEl.classList.remove('hidden');
        return;
    }

    const project = loadProject(id);
    if (!project || !project.data || !Array.isArray(project.data.nodes) || project.data.nodes.length < 2) {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (errEl) errEl.classList.remove('hidden');
        return;
    }

    if (loadingEl) loadingEl.classList.add('hidden');
    document.getElementById('hud-track-name').textContent = (project.name || 'Untitled Circuit').toUpperCase();

    const viewer = new Track3DViewer(project);
    viewer.syncAutoBtn();
    window.track3d = viewer;
}

window.addEventListener('load', boot);
