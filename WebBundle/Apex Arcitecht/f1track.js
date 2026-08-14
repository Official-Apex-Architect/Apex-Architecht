const MIN_TRACK_WIDTH = 12;

class TrackNode {
    constructor(x, y) {
        this.cpIn = null;
        this.cpOut = null;
        this.x = x;
        this.y = y;
        this.sharpness = 0;
        this.sector = 1;
        this.isDRS = false;
        this.type = 'straight';
        this.turnNumber = 0;
        this.elevation = 0; // BETA: height in metres relative to track datum
        this.isElevationTransition = false; // blend this node's height between neighboring fixed heights
        this.customWidth = null; // number >= 12 or null (default/transition)
        this.isTransition = false; // boolean: blend this node between neighboring fixed widths
    }
}
class App {
    constructor() {
        window.appInstance = this;
        this.nodes = [];
        this.pitNodes = [];
        this.selectedPitIndex = -1;
        this.selectedIndices = new Set();
        this.currentTool = 'draw';
        // Interaction States
        this.isDragging = false;
        this.isPanning = false;
        this.isBoxSelecting = false;
        this.selectionBox = null;
        this.draggedHandle = 'node';
        this.draggedNodeIdx = -1;
        // Viewport & Scale
        this.scale = 1.0;
        this.offset = { x: 0, y: 0 };
        this.lastMouse = { x: 0, y: 0 };
        this.isSpacePressed = false;
        this.HIT_RADIUS = 20;
        this.scaleUnit = 'km';
        this.pxPerUnit = 100;
        this.trackWidth = 36;
        // Track Features
        this.isClosedTrack = false;
        this.selectedTrackTags = [];
        this.selectedRallyFormat = 'normal';
        this.membershipAccess = { tags: [], tier: null, tagLabels: {}, lengthLimits: {}, hasSubscription: false };
        // Background
        this.bgImage = null;
        this.bgOpacity = 0.5;
        this.bgScale = 1.0;
        // Project Management
        this.currentProjectId = '';
        this.saveTimeout = null;
        this.STORAGE_KEY = 'apex_projects_v1';
        this.hasUnsavedChanges = false;
        this.history = [];
        this.historyIndex = -1;
        this.isApplyingHistory = false;
        this.canvas = document.getElementById('trackCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.init();
    }
    async init() {
        await this.waitForAuthBootstrap();
        await this.loadMembershipAccess();
        this.resize();
        this.setupEventListeners();
        this.setupUIListeners();
        this.applyBetaGating();
        this.handleRouting();
    }
    /** "Best deal" = top all-access tier. Elevation + 3D are beta-gated to it. */
    isBetaUser() {
        return !!(this.membershipAccess && this.membershipAccess.tier === 'all_access');
    }
    applyBetaGating() {
        const beta = this.isBetaUser();
        const elevSection = document.getElementById('elevation-section');
        const view3dBtn = document.getElementById('view-3d-btn');
        if (elevSection) elevSection.classList.toggle('hidden', !beta);
        if (view3dBtn) view3dBtn.classList.toggle('hidden', !beta);
    }
    async waitForAuthBootstrap() {
        if (!window.supabase || !window.supabase.auth)
            return;
        for (let attempt = 0; attempt < 20; attempt++) {
            try {
                const { data: { user } } = await window.supabase.auth.getUser();
                if (user)
                    return;
            }
            catch (error) {
                console.warn('[Track Tags] Auth bootstrap check failed:', error);
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
    }
    async loadMembershipAccess() {
        if (!window.ApexMembership) {
            this.renderTrackTagSelector();
            return;
        }
        try {
            this.membershipAccess = await ApexMembership.getAvailableTags();
        }
        catch (error) {
            console.warn('[Track Tags] Membership lookup failed:', error);
            this.membershipAccess = { tags: [], tier: null, tagLabels: {}, lengthLimits: {}, hasSubscription: false };
        }
        this.selectedTrackTags = this.normalizeTrackTags(this.selectedTrackTags);
        if (this.membershipAccess.tags.length === 1 && this.selectedTrackTags.length === 0) {
            this.selectedTrackTags = [...this.membershipAccess.tags];
        }
        this.renderTrackTagSelector();
        this.renderSelectedTrackTags();
        this.updateCloseCircuitAvailability();
    }
    normalizeTrackTags(tags) {
        const availableTags = (this.membershipAccess && this.membershipAccess.tags) || [];
        const uniqueTags = Array.from(new Set((tags || []).filter(tag => availableTags.includes(tag))));
        if (window.ApexMembership && !ApexMembership.isValidTagCombination(uniqueTags)) {
            return uniqueTags.filter(tag => !ApexMembership.RALLY_TAGS.includes(tag));
        }
        return uniqueTags;
    }
    getTagLabel(tag) {
        return (this.membershipAccess.tagLabels || {})[tag] || tag;
    }
    getSelectedTagLabels() {
        return this.selectedTrackTags.map(tag => this.getTagLabel(tag));
    }
    renderSelectedTrackTags() {
        const el = document.getElementById('selected-track-tags');
        if (!el)
            return;
        if (!this.hasSubscription()) {
            el.innerText = 'AI DETECTS: EVALUATING...';
            return;
        }
        if (this.selectedTrackTags.length === 0) {
            el.innerText = 'SELECT TRACK TAGS';
            return;
        }
        el.innerText = this.getSelectedTagLabels().join(' + ').toUpperCase();
    }
    hasPremiumAccess() {
        return (this.membershipAccess.tags || []).length > 0;
    }
    hasSubscription() {
        return !!(this.membershipAccess && this.membershipAccess.hasSubscription);
    }
    describeSelectedTagRules(tags) {
        if (!tags || tags.length === 0) {
            return 'Select one or more tags to define what this layout should support.';
        }
        return tags.map(tag => {
            const limits = (this.membershipAccess.lengthLimits || {})[tag];
            if (!limits)
                return this.getTagLabel(tag);
            if (tag === 'rallying' && limits.variants) {
                const selectedVariant = limits.variants[this.selectedRallyFormat];
                if (selectedVariant) {
                    const closedState = selectedVariant.closed ? 'closed' : 'open';
                    const totalText = selectedVariant.totalMin && selectedVariant.totalMax
                        ? ` ${selectedVariant.totalMin}-${selectedVariant.totalMax} km total.`
                        : '';
                    return `${this.getTagLabel(tag)} (${this.selectedRallyFormat.toUpperCase()}): ${selectedVariant.min}-${selectedVariant.max} km ${closedState}.${totalText}`;
                }
                return `${this.getTagLabel(tag)}: normal SS 1-2 km closed, stage 3-50 km open (300-350 km total), raid 100-800 km open (3,000-8,000 km total).`;
            }
            const closedState = limits.closed ? 'closed' : 'open';
            return `${this.getTagLabel(tag)}: ${limits.min}-${limits.max} ${limits.unit} ${closedState} track.`;
        }).join(' ');
    }
    renderRallyFormatSelector() {
        const container = document.getElementById('rally-format-selector');
        if (!container)
            return;
        const rallyLimits = (((this.membershipAccess || {}).lengthLimits || {}).rallying || {}).variants;
        if (!this.hasSubscription() || !this.selectedTrackTags.includes('rallying') || !rallyLimits) {
            container.innerHTML = '';
            return;
        }
        const formatLabels = {
            normal: 'Normal SS',
            stage: 'Stage Rally',
            raid: 'Raid Rally'
        };
        container.innerHTML = `
            <div class="rounded-xl border border-white/10 bg-black/20 px-3 py-3">
                <div class="text-[10px] font-bold uppercase tracking-widest text-[#4ade80]">Rally Format</div>
                <div class="mt-2 grid grid-cols-1 gap-2">
                    ${Object.entries(rallyLimits).map(([key, limits]) => `
                        <label class="flex items-center justify-between gap-3 rounded-lg border ${this.selectedRallyFormat === key ? 'border-[#4ade80]/40 bg-[#4ade80]/10 text-white' : 'border-white/10 bg-black/30 text-white/80'} px-3 py-2 cursor-pointer">
                            <span class="text-[11px] font-bold uppercase tracking-wider">${formatLabels[key] || key}</span>
                            <input type="radio" name="rally-format" class="h-4 w-4 accent-[#22c55e]" value="${key}" ${this.selectedRallyFormat === key ? 'checked' : ''}>
                        </label>
                    `).join('')}
                </div>
            </div>
        `;
        container.querySelectorAll('input[name="rally-format"]').forEach(input => {
            input.addEventListener('change', (event) => {
                this.selectedRallyFormat = event.currentTarget.value;
                this.syncTrackClosureFromSelection();
                this.renderRallyFormatSelector();
                this.renderTrackTagSelector();
                this.queueAutoSave();
                this.draw();
            });
        });
    }
    selectedRallyLimits() {
        const rallyLimits = (((this.membershipAccess || {}).lengthLimits || {}).rallying || {}).variants;
        return rallyLimits ? rallyLimits[this.selectedRallyFormat] || null : null;
    }
    getActiveLengthRule() {
        if (this.selectedTrackTags.includes('rallying')) {
            const rallyRule = this.selectedRallyLimits();
            if (rallyRule) {
                return {
                    min: rallyRule.min,
                    max: rallyRule.max,
                    unit: 'km',
                    source: 'rally'
                };
            }
        }
        if (window.ApexMembership && this.membershipAccess.tier && this.selectedTrackTags.length > 0) {
            const range = ApexMembership.getLengthLimitsForTags(this.selectedTrackTags, this.membershipAccess.tier);
            if (range) {
                return {
                    min: range.min,
                    max: range.max,
                    unit: 'km',
                    source: 'membership'
                };
            }
        }
        return { min: 0, max: 30, unit: 'km', source: 'default' };
    }
    getLengthLimitMessage() {
        const rule = this.getActiveLengthRule();
        const label = this.selectedTrackTags.length > 0
            ? this.getSelectedTagLabels().join(' + ')
            : 'this track';
        return `Length limit for ${label}: ${rule.min}-${rule.max} ${rule.unit.toUpperCase()}.`;
    }
    canAddMoreTrackLength() {
        const rule = this.getActiveLengthRule();
        if (this.getTrackLengthKM() <= rule.max) {
            return true;
        }
        alert(`Maximum track length reached. ${this.getLengthLimitMessage()}`);
        return false;
    }
    currentSelectionAllowsClosedCircuit() {
        if (!this.selectedTrackTags.includes('rallying'))
            return true;
        const rallyLimits = this.selectedRallyLimits();
        return rallyLimits ? !!rallyLimits.closed : true;
    }
    syncTrackClosureFromSelection() {
        if (this.currentSelectionAllowsClosedCircuit())
            return;
        this.isClosedTrack = false;
    }
    updateCloseCircuitAvailability() {
        const closeBtn = document.getElementById('toggle-close-btn');
        if (!closeBtn)
            return;
        const canClose = this.currentSelectionAllowsClosedCircuit();
        if (!canClose) {
            this.isClosedTrack = false;
            closeBtn.classList.remove('toggle-closed');
            closeBtn.style.display = 'none';
            return;
        }
        closeBtn.style.display = '';
        closeBtn.classList.toggle('toggle-closed', this.isClosedTrack);
    }
    renderTrackTagSelector() {
        const selector = document.getElementById('track-tag-selector');
        const noteEl = document.getElementById('membership-tag-note');
        const rulesEl = document.getElementById('selected-tag-rules');
        if (!selector || !noteEl || !rulesEl)
            return;
        const availableTags = this.membershipAccess.tags || [];
        if (!this.hasSubscription()) {
            noteEl.innerHTML = `No premium subscription is active. You can still build freely here, and the AI will classify the layout automatically.`;
            selector.innerHTML = '';
            this.renderRallyFormatSelector();
            this.updateCloseCircuitAvailability();
            rulesEl.textContent = 'Track tags stay optional until a premium subscription is active on this account.';
            return;
        }
        const tierName = this.membershipAccess.tier && window.ApexMembership
            ? ApexMembership.TIERS[this.membershipAccess.tier].name
            : 'Premium Membership';
        noteEl.textContent = `Active membership: ${tierName}`;
        if (availableTags.length === 1) {
            const onlyTag = availableTags[0];
            selector.innerHTML = `
                <div class="rounded-xl border border-[#a855f7]/30 bg-[#a855f7]/10 px-3 py-3">
                    <div class="text-[10px] font-bold uppercase tracking-widest text-[#d8b4fe]">Locked Track Tag</div>
                    <div class="mt-1 text-sm font-semibold text-white">${this.getTagLabel(onlyTag)}</div>
                </div>
            `;
            this.renderRallyFormatSelector();
            this.updateCloseCircuitAvailability();
            rulesEl.textContent = this.describeSelectedTagRules([onlyTag]);
            return;
        }
        selector.innerHTML = availableTags.map(tag => {
            const checked = this.selectedTrackTags.includes(tag);
            const isRally = window.ApexMembership && ApexMembership.RALLY_TAGS.includes(tag);
            const hasRallySelected = this.selectedTrackTags.some(selectedTag => ApexMembership.RALLY_TAGS.includes(selectedTag));
            const hasCircuitSelected = this.selectedTrackTags.some(selectedTag => ApexMembership.CIRCUIT_TAGS.includes(selectedTag));
            const disableForMix = checked
                ? false
                : (isRally && hasCircuitSelected) || (!isRally && hasRallySelected);
            return `
                <label class="flex items-center justify-between gap-3 rounded-xl border px-3 py-3 transition ${checked ? 'border-[#a855f7]/40 bg-[#a855f7]/10 text-white' : 'border-white/10 bg-black/20 text-white/80'} ${disableForMix ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:border-white/20'}">
                    <span class="text-[11px] font-bold uppercase tracking-wider">${this.getTagLabel(tag)}</span>
                    <input type="checkbox" class="track-tag-checkbox h-4 w-4 accent-[#a855f7]" data-tag="${tag}" ${checked ? 'checked' : ''} ${disableForMix ? 'disabled' : ''}>
                </label>
            `;
        }).join('');
        selector.querySelectorAll('.track-tag-checkbox').forEach(box => {
            box.addEventListener('change', (event) => {
                const input = event.currentTarget;
                const next = new Set(this.selectedTrackTags);
                if (input.checked)
                    next.add(input.dataset.tag);
                else
                    next.delete(input.dataset.tag);
                this.applySelectedTrackTags(Array.from(next));
            });
        });
        this.renderRallyFormatSelector();
        this.updateCloseCircuitAvailability();
        rulesEl.textContent = this.describeSelectedTagRules(this.selectedTrackTags);
    }
    applySelectedTrackTags(tags) {
        if (window.ApexMembership && !ApexMembership.isValidTagCombination(tags)) {
            alert('Rallying cannot be combined with F1/F2/F3, Go-Karting, GT, Hypercar, or LMP before building the track.');
            this.renderTrackTagSelector();
            return false;
        }
        this.selectedTrackTags = this.normalizeTrackTags(tags);
        if (this.selectedTrackTags.length === 0 && this.membershipAccess.tags.length === 1) {
            this.selectedTrackTags = [...this.membershipAccess.tags];
        }
        if (!this.selectedTrackTags.includes('rallying')) {
            this.selectedRallyFormat = 'normal';
        }
        this.syncTrackClosureFromSelection();
        this.renderTrackTagSelector();
        this.renderSelectedTrackTags();
        this.queueAutoSave();
        this.updateStats();
        return true;
    }
    ensureTrackTagsSelected() {
        if (!this.hasSubscription())
            return true;
        if (this.selectedTrackTags.length > 0)
            return true;
        alert('Select your track tag(s) before making the track.');
        return false;
    }
    handleRouting() {
        const urlParams = new URLSearchParams(window.location.search);
        const projectId = urlParams.get('id');
        const isNew = urlParams.get('new') === 'true';
        if (isNew) {
            this.createNewProject();
        }
        else if (projectId) {
            this.loadProject(projectId);
        }
        else {
            // Default behavior: try to load the most recent project
            this.loadInitialProject();
        }
    }
    loadInitialProject() {
        const projects = this.getAllProjects();
        if (projects.length > 0) {
            projects.sort((a, b) => b.lastModified - a.lastModified);
            this.loadProject(projects[0].id);
        }
        else {
            this.createNewProject();
        }
    }
    resize() {
        const parent = this.canvas.parentElement;
        this.canvas.width = parent.clientWidth;
        this.canvas.height = parent.clientHeight;
        this.draw();
    }
    screenToWorld(x, y) {
        return { x: (x - this.offset.x) / this.scale, y: (y - this.offset.y) / this.scale };
    }
    getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }
    getCtrlPts(i) {
        var _a, _b, _c, _d;
        const n = this.nodes[i];
        const len = this.nodes.length;
        let pPrev, pNext;
        if (this.isClosedTrack) {
            pPrev = this.nodes[(i - 1 + len) % len];
            pNext = this.nodes[(i + 1) % len];
        }
        else {
            pPrev = i > 0 ? this.nodes[i - 1] : { x: n.x - (((_a = this.nodes[i + 1]) === null || _a === void 0 ? void 0 : _a.x) - n.x || 100), y: n.y - (((_b = this.nodes[i + 1]) === null || _b === void 0 ? void 0 : _b.y) - n.y || 0) };
            pNext = i < len - 1 ? this.nodes[i + 1] : { x: n.x + (n.x - ((_c = this.nodes[i - 1]) === null || _c === void 0 ? void 0 : _c.x) || 100), y: n.y + (n.y - ((_d = this.nodes[i - 1]) === null || _d === void 0 ? void 0 : _d.y) || 0) };
        }
        if (!pPrev)
            pPrev = { x: n.x - 50, y: n.y };
        if (!pNext)
            pNext = { x: n.x + 50, y: n.y };
        let tx = (pNext.x - pPrev.x) / 6;
        let ty = (pNext.y - pPrev.y) / 6;
        // Adjust default tangents based on corner type profile
        const lenSq = tx * tx + ty * ty;
        const normalizeDist = Math.sqrt(lenSq) || 1;
        if (n.type === 'hairpin') {
            tx *= 2.0;
            ty *= 2.0;
        }
        else if (n.type === 'chicane') {
            tx *= 0.3;
            ty *= 0.3;
        }
        else if (n.type === 'medium') {
            tx *= 1.2;
            ty *= 1.2;
        }
        else if (n.type === 'high') {
            tx *= 0.8;
            ty *= 0.8;
        }
        // Sharpness modifier shrinks or grows the tangents beyond default
        const sharpFactor = 1.0 - (n.sharpness / 200); // -100 to 100 -> 1.5 to 0.5
        tx *= sharpFactor;
        ty *= sharpFactor;
        const pIn = n.cpIn ? { x: n.x + n.cpIn.x, y: n.y + n.cpIn.y } : { x: n.x - tx, y: n.y - ty };
        const pOut = n.cpOut ? { x: n.x + n.cpOut.x, y: n.y + n.cpOut.y } : { x: n.x + tx, y: n.y + ty };
        return { pIn, pOut };
    }
    hitTest(world) {
        const hitRadiusSq = (this.HIT_RADIUS / this.scale) * (this.HIT_RADIUS / this.scale);
        if (this.currentTool === 'tangent' && this.selectedIndices.size > 0) {
            for (const idx of this.selectedIndices) {
                const ctrls = this.getCtrlPts(idx);
                if (Math.pow(world.x - ctrls.pIn.x, 2) + Math.pow(world.y - ctrls.pIn.y, 2) < hitRadiusSq) {
                    return { idx, handle: 'cpIn' };
                }
                if (Math.pow(world.x - ctrls.pOut.x, 2) + Math.pow(world.y - ctrls.pOut.y, 2) < hitRadiusSq) {
                    return { idx, handle: 'cpOut' };
                }
            }
        }
        for (let i = 0; i < this.nodes.length; i++) {
            const n = this.nodes[i];
            if (Math.pow(world.x - n.x, 2) + Math.pow(world.y - n.y, 2) < hitRadiusSq) {
                return { idx: i, handle: 'node' };
            }
        }
        return { idx: -1, handle: 'none' };
    }
    hitTestPit(world) {
        const hitRadiusSq = (this.HIT_RADIUS / this.scale) * (this.HIT_RADIUS / this.scale);
        for (let i = 0; i < this.pitNodes.length; i++) {
            const p = this.pitNodes[i];
            if (Math.pow(world.x - p.x, 2) + Math.pow(world.y - p.y, 2) < hitRadiusSq)
                return i;
        }
        return -1;
    }
    updateCursor(mouse) {
        if (this.isPanning) {
            this.canvas.style.cursor = 'grabbing';
        }
        else if (this.isSpacePressed) {
            this.canvas.style.cursor = 'grab';
        }
        else if (!this.isDragging && !this.isBoxSelecting) {
            const world = this.screenToWorld(mouse.x, mouse.y);
            const hit = this.hitTest(world);
            this.canvas.style.cursor = hit.idx !== -1 ? 'pointer' : 'crosshair';
        }
    }
    setupEventListeners() {
        window.addEventListener('resize', () => this.resize());
        this.canvas.addEventListener('contextmenu', e => e.preventDefault());
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                this.isSpacePressed = true;
                if (!this.isPanning && !this.isBoxSelecting)
                    this.canvas.style.cursor = 'grab';
            }
            
            // Undo/Redo Shortcuts
            const isCmdOrCtrl = e.ctrlKey || e.metaKey;
            const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
            if (isCmdOrCtrl && !isInput) {
                if (e.key.toLowerCase() === 'z') {
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.redo();
                    } else {
                        this.undo();
                    }
                } else if (e.key.toLowerCase() === 'y') {
                    e.preventDefault();
                    this.redo();
                }
            }
        });
        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.isSpacePressed = false;
                if (!this.isPanning && !this.isBoxSelecting)
                    this.canvas.style.cursor = 'crosshair';
            }
        });
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            const mouse = this.getMousePos(e);
            const zoomFactor = Math.pow(0.995, e.deltaY);
            const newScale = Math.min(Math.max(0.01, this.scale * zoomFactor), 20);
            const worldPos = this.screenToWorld(mouse.x, mouse.y);
            this.scale = newScale;
            this.offset.x = mouse.x - worldPos.x * this.scale;
            this.offset.y = mouse.y - worldPos.y * this.scale;
            document.getElementById('zoom-text').innerText = `Zoom: ${Math.round(this.scale * 100)}%`;
            this.updateCursor(mouse);
            this.draw();
        }, { passive: false });
        this.canvas.addEventListener('mousedown', (e) => {
            const mouse = this.getMousePos(e);
            this.lastMouse = mouse;
            if (e.button === 2 || e.button === 1 || this.isSpacePressed) {
                this.isPanning = true;
                this.updateCursor(mouse);
                return;
            }
            const world = this.screenToWorld(mouse.x, mouse.y);
            const hit = this.hitTest(world);
            const pitHit = this.hitTestPit(world);
            if (this.currentTool === 'pits' && pitHit !== -1) {
                this.selectedPitIndex = pitHit;
                this.selectedIndices.clear();
                this.isDragging = true;
            }
            else if (hit.idx !== -1) {
                this.draggedHandle = hit.handle;
                this.draggedNodeIdx = hit.idx;
                this.selectedPitIndex = -1;
                if (this.currentTool === 'drs' && hit.handle === 'node') {
                    this.nodes[hit.idx].isDRS = !this.nodes[hit.idx].isDRS;
                }
                else if (this.currentTool === 'sector' && hit.handle === 'node') {
                    this.nodes[hit.idx].sector = (this.nodes[hit.idx].sector % 3) + 1;
                }
                else if (this.currentTool === 'delete' && hit.handle === 'node') {
                    this.nodes.splice(hit.idx, 1);
                    this.selectedIndices.clear();
                    this.draggedHandle = 'none';
                    this.draggedNodeIdx = -1;
                }
                else if (this.currentTool === 'turns' && hit.handle === 'node') {
                    if (this.nodes[hit.idx].turnNumber > 0) {
                        this.nodes[hit.idx].turnNumber = 0;
                    } else {
                        let maxTurn = 0;
                        for (const n of this.nodes) {
                            if (n.turnNumber > maxTurn) maxTurn = n.turnNumber;
                        }
                        this.nodes[hit.idx].turnNumber = maxTurn + 1;
                    }
                }
                else {
                    if (this.currentTool === 'select' && e.shiftKey) {
                        if (this.selectedIndices.has(hit.idx)) {
                            this.selectedIndices.delete(hit.idx);
                        }
                        else {
                            this.selectedIndices.add(hit.idx);
                        }
                    }
                    else {
                        if (!this.selectedIndices.has(hit.idx) && hit.handle === 'node') {
                            this.selectedIndices.clear();
                            this.selectedIndices.add(hit.idx);
                        }
                    }
                    this.isDragging = true;
                }
                this.queueAutoSave(); // Capture property changes (DRS, sector, delete)
            }
            else {
                // Clicked empty space
                if (this.currentTool === 'select') {
                    if (!e.shiftKey)
                        this.selectedIndices.clear();
                    this.selectedPitIndex = -1;
                    this.isBoxSelecting = true;
                    this.selectionBox = { start: world, end: world };
                }
                else if (this.currentTool === 'draw') {
                    if (!this.ensureTrackTagsSelected()) {
                        return;
                    }
                    const n = new TrackNode(world.x, world.y);
                    if (this.selectedIndices.size === 1) {
                        const idx = Array.from(this.selectedIndices)[0];
                        if (!this.canAddMoreTrackLength()) {
                            return;
                        }
                        if (idx < this.nodes.length - 1) {
                            this.nodes.splice(idx + 1, 0, n);
                            this.selectedIndices.clear();
                            this.selectedIndices.add(idx + 1);
                        }
                        else {
                            this.nodes.push(n);
                            this.selectedIndices.clear();
                            this.selectedIndices.add(this.nodes.length - 1);
                        }
                    }
                    else {
                        if (!this.canAddMoreTrackLength()) {
                            return;
                        }
                        this.nodes.push(n);
                        this.selectedIndices.clear();
                        this.selectedIndices.add(this.nodes.length - 1);
                    }
                    this.isDragging = true;
                    this.draggedHandle = 'node';
                    this.draggedNodeIdx = Array.from(this.selectedIndices)[0];
                    this.queueAutoSave(); // Added node
                }
                else if (this.currentTool === 'pits') {
                    this.pitNodes.push({ x: world.x, y: world.y });
                    this.selectedPitIndex = this.pitNodes.length - 1;
                    this.selectedIndices.clear();
                    this.queueAutoSave();
                }
                else {
                    this.selectedIndices.clear();
                    this.selectedPitIndex = -1;
                }
            }
            this.updateUI();
            this.draw();
        });
        window.addEventListener('mousemove', (e) => {
            const mouse = this.getMousePos(e);
            const dx = mouse.x - this.lastMouse.x, dy = mouse.y - this.lastMouse.y;
            if (this.isPanning) {
                this.offset.x += dx;
                this.offset.y += dy;
                this.draw();
            }
            else if (this.isBoxSelecting && this.selectionBox) {
                this.selectionBox.end = this.screenToWorld(mouse.x, mouse.y);
                this.draw();
            }
            else if (this.isDragging) {
                const dwx = dx / this.scale;
                const dwy = dy / this.scale;
                if (this.currentTool === 'pits' && this.selectedPitIndex !== -1) {
                    this.pitNodes[this.selectedPitIndex].x += dwx;
                    this.pitNodes[this.selectedPitIndex].y += dwy;
                }
                else if (this.draggedHandle === 'node' && this.selectedIndices.size > 0) {
                    const COORD_LIMIT = 50000;
                    for (const idx of this.selectedIndices) {
                        this.nodes[idx].x = Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, this.nodes[idx].x + dwx));
                        this.nodes[idx].y = Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, this.nodes[idx].y + dwy));
                    }
                }
                else if (this.draggedNodeIdx !== -1) {
                    const n = this.nodes[this.draggedNodeIdx];
                    if (this.draggedHandle === 'cpIn') {
                        const currentPts = this.getCtrlPts(this.draggedNodeIdx);
                        n.cpIn = { x: currentPts.pIn.x + dwx - n.x, y: currentPts.pIn.y + dwy - n.y };
                    }
                    else if (this.draggedHandle === 'cpOut') {
                        const currentPts = this.getCtrlPts(this.draggedNodeIdx);
                        n.cpOut = { x: currentPts.pOut.x + dwx - n.x, y: currentPts.pOut.y + dwy - n.y };
                    }
                }
                this.draw();
            }
            this.lastMouse = mouse;
            this.updateCursor(mouse);
        });
        window.addEventListener('mouseup', (e) => {
            if (this.isBoxSelecting && this.selectionBox) {
                const minX = Math.min(this.selectionBox.start.x, this.selectionBox.end.x);
                const maxX = Math.max(this.selectionBox.start.x, this.selectionBox.end.x);
                const minY = Math.min(this.selectionBox.start.y, this.selectionBox.end.y);
                const maxY = Math.max(this.selectionBox.start.y, this.selectionBox.end.y);
                for (let i = 0; i < this.nodes.length; i++) {
                    const n = this.nodes[i];
                    if (n.x >= minX && n.x <= maxX && n.y >= minY && n.y <= maxY) {
                        this.selectedIndices.add(i);
                    }
                }
                this.isBoxSelecting = false;
                this.selectionBox = null;
                this.updateUI();
                this.draw();
            }
            if (this.isDragging)
                this.queueAutoSave(); // Finished drag
            this.isDragging = false;
            this.isPanning = false;
            this.draggedHandle = 'node';
            this.draggedNodeIdx = -1;
            this.updateCursor(this.getMousePos(e));
        });
    }
    setupInspectorPanel() {
        const inspector = document.getElementById('inspector');
        const workspace = document.getElementById('track-workspace');
        const handle = document.getElementById('inspector-drag-handle');
        if (!inspector || !workspace || !handle) return;

        // Move the panel into the workspace so it can float independently of the bottom dock.
        workspace.append(inspector);
        this.inspectorPanel = inspector;
        this.inspectorWorkspace = workspace;
        const storageKey = 'apex_inspector_panel_v1';
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch (_) { saved = {}; }
        // Always start attached to the bottom dock. Saved dimensions are kept,
        // but a previous floating position never becomes the default layout.
        this.inspectorLayout = 'dock';

        const persist = () => {
            if (!this.inspectorPanel) return;
            const panelRect = inspector.getBoundingClientRect();
            const workspaceRect = workspace.getBoundingClientRect();
            const state = {
                layout: this.inspectorLayout,
                width: Math.round(panelRect.width),
                height: Math.round(panelRect.height)
            };
            if (this.inspectorLayout === 'custom') {
                state.left = Math.round(panelRect.left - workspaceRect.left);
                state.top = Math.round(panelRect.top - workspaceRect.top);
            }
            try { localStorage.setItem(storageKey, JSON.stringify(state)); } catch (_) { /* Storage is optional. */ }
        };

        const applyLayout = (layout, restore = false) => {
            this.inspectorLayout = layout;
            inspector.style.left = '';
            inspector.style.top = '';
            inspector.style.right = '';
            inspector.style.bottom = '';
            inspector.style.transform = '';
            if (restore && saved.width) inspector.style.width = `${saved.width}px`;
            if (restore && saved.height) inspector.style.height = `${saved.height}px`;

            if (layout === 'lower-left') {
                inspector.style.left = '1rem';
                inspector.style.bottom = '1rem';
            } else if (layout === 'upper-right') {
                inspector.style.right = '1rem';
                inspector.style.top = '1rem';
            } else if (layout === 'center') {
                inspector.style.left = '50%';
                inspector.style.top = '50%';
                inspector.style.transform = 'translate(-50%, -50%)';
            } else if (layout === 'custom' && restore && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
                inspector.style.left = `${saved.left}px`;
                inspector.style.top = `${saved.top}px`;
            } else {
                this.inspectorLayout = 'dock';
                inspector.style.right = '20rem';
                inspector.style.bottom = '1rem';
            }
            document.querySelectorAll('[data-inspector-layout]').forEach(button => {
                button.classList.toggle('active', button.dataset.inspectorLayout === this.inspectorLayout);
            });
            persist();
        };

        document.querySelectorAll('[data-inspector-layout]').forEach(button => {
            button.addEventListener('click', () => applyLayout(button.dataset.inspectorLayout));
        });
        applyLayout('dock', true);

        let drag = null;
        handle.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            const panelRect = inspector.getBoundingClientRect();
            const workspaceRect = workspace.getBoundingClientRect();
            drag = {
                offsetX: event.clientX - panelRect.left,
                offsetY: event.clientY - panelRect.top,
                workspaceRect
            };
            this.inspectorLayout = 'custom';
            inspector.style.transform = '';
            inspector.style.right = '';
            inspector.style.bottom = '';
            inspector.style.left = `${panelRect.left - workspaceRect.left}px`;
            inspector.style.top = `${panelRect.top - workspaceRect.top}px`;
            inspector.classList.add('is-dragging');
            handle.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        handle.addEventListener('pointermove', (event) => {
            if (!drag) return;
            const maxLeft = Math.max(0, workspace.clientWidth - inspector.offsetWidth);
            const maxTop = Math.max(0, workspace.clientHeight - inspector.offsetHeight);
            const left = Math.min(maxLeft, Math.max(0, event.clientX - drag.workspaceRect.left - drag.offsetX));
            const top = Math.min(maxTop, Math.max(0, event.clientY - drag.workspaceRect.top - drag.offsetY));
            inspector.style.left = `${left}px`;
            inspector.style.top = `${top}px`;
        });
        const endDrag = (event) => {
            if (!drag) return;
            drag = null;
            inspector.classList.remove('is-dragging');
            if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
            document.querySelectorAll('[data-inspector-layout]').forEach(button => button.classList.remove('active'));
            persist();
        };
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);

        if (window.ResizeObserver) {
            new ResizeObserver(() => persist()).observe(inspector);
        }
    }
    setupUIListeners() {
        this.setupInspectorPanel();
        // Undo / Redo buttons
        document.getElementById('undo-btn').addEventListener('click', () => this.undo());
        document.getElementById('redo-btn').addEventListener('click', () => this.redo());
        // Project Management Listeners
        const nameInput = document.getElementById('project-name-input');
        nameInput.addEventListener('change', () => {
            if (!nameInput.value.trim())
                nameInput.value = 'Untitled Circuit';
            this.hasUnsavedChanges = true;
            this.saveProject();
        });
        document.querySelectorAll('.tool-btn').forEach(btn => btn.addEventListener('click', (e) => this.setTool(e.currentTarget.dataset.tool)));
        const scaleUnitEl = document.getElementById('scale-unit');
        scaleUnitEl.addEventListener('change', (e) => {
            this.scaleUnit = e.target.value;
            this.updateTargetLength();
            this.draw();
            this.queueAutoSave();
        });
        document.getElementById('px-unit').addEventListener('input', (e) => {
            this.pxPerUnit = parseInt(e.target.value);
            document.getElementById('px-unit-val').innerText = `${this.pxPerUnit} px`;
            document.getElementById('target-length-input').value = ''; // Reset target length if manually sliding
            this.draw();
            this.queueAutoSave();
        });
        document.getElementById('track-width-slider')?.addEventListener('input', (e) => {
            this.setTrackWidth(e.target.value);
        });
        document.getElementById('track-width-input')?.addEventListener('change', (e) => {
            this.setTrackWidth(e.target.value);
        });
        document.getElementById('target-length-input')?.addEventListener('input', (e) => {
            this.updateTargetLength();
            this.queueAutoSave();
        });
        document.getElementById('apply-length-btn')?.addEventListener('click', () => {
            this.updateTargetLength();
            this.queueAutoSave();
        });
        document.getElementById('rescale-geometry-btn')?.addEventListener('click', () => {
            this.rescaleTrackGeometry();
        });
        document.getElementById('ai-analysis-btn').addEventListener('click', () => {
            this.analyzeTrackSegments();
        });
        document.getElementById('bg-upload').addEventListener('change', (e) => {
            var _a;
            const file = (_a = e.target.files) === null || _a === void 0 ? void 0 : _a[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (re) => {
                    var _a;
                    const img = new Image();
                    img.crossOrigin = 'anonymous';
                    img.onload = () => {
                        this.bgImage = img;
                        document.getElementById('ai-trace-btn').classList.remove('hidden');
                        this.draw();
                        this.queueAutoSave();
                    };
                    img.onerror = () => {
                        alert('Could not load the background image. The file may be corrupted or blocked by CORS policy.');
                    };
                    img.src = (_a = re.target) === null || _a === void 0 ? void 0 : _a.result;
                };
                reader.onerror = () => alert('Failed to read the image file.');
                reader.readAsDataURL(file);
            }
        });
        document.getElementById('ai-trace-btn').addEventListener('click', () => {
            this.autoTraceTrack();
        });
        document.getElementById('ai-suggest-toggle').addEventListener('click', () => {
            const panel = document.getElementById('ai-suggestions-panel');
            const chevron = document.getElementById('ai-suggest-chevron');
            const isOpen = !panel.classList.contains('hidden');
            panel.classList.toggle('hidden', isOpen);
            chevron.style.transform = isOpen ? '' : 'rotate(180deg)';
        });
        document.getElementById('bg-opacity').addEventListener('input', (e) => {
            this.bgOpacity = parseInt(e.target.value) / 100;
            document.getElementById('bg-opacity-val').innerText = `${e.target.value}%`;
            this.draw();
            this.queueAutoSave();
        });
        document.getElementById('bg-scale').addEventListener('input', (e) => {
            this.bgScale = parseInt(e.target.value) / 100;
            document.getElementById('bg-scale-val').innerText = `${this.bgScale.toFixed(1)}x`;
            this.draw();
            this.queueAutoSave();
        });
        document.getElementById('toggle-close-btn').addEventListener('click', (e) => {
            if (!this.ensureTrackTagsSelected())
                return;
            if (!this.currentSelectionAllowsClosedCircuit())
                return;
            this.isClosedTrack = !this.isClosedTrack;
            const btn = e.currentTarget;
            btn.classList.toggle('toggle-closed', this.isClosedTrack);
            this.draw();
            this.queueAutoSave();
        });
        document.getElementById('corner-radius').oninput = (e) => {
            const v = parseInt(e.target.value);
            if (this.selectedIndices.size > 0) {
                for (const idx of this.selectedIndices)
                    this.nodes[idx].sharpness = v;
                document.getElementById('val-angle').innerText = v.toString();
                this.draw();
            }
        };
        document.getElementById('corner-radius').addEventListener('change', () => {
            if (this.selectedIndices.size > 0) {
                this.queueAutoSave();
            }
        });
        const elevInput = document.getElementById('elevation-range');
        if (elevInput) {
            elevInput.addEventListener('input', (e) => {
                if (!this.isBetaUser() || this.selectedIndices.size === 0) return;
                const v = parseInt(e.target.value, 10) || 0;
                for (const idx of this.selectedIndices) {
                    this.nodes[idx].elevation = v;
                    this.nodes[idx].isElevationTransition = false;
                }
                const elevVal = document.getElementById('val-elevation');
                if (elevVal) elevVal.innerText = (v > 0 ? '+' : '') + v + ' m';
                this.updateUI();
                this.draw();
            });
            elevInput.addEventListener('change', () => {
                if (this.isBetaUser() && this.selectedIndices.size > 0) this.queueAutoSave();
            });
        }
        document.getElementById('elevation-fixed-btn')?.addEventListener('click', () => {
            if (!this.isBetaUser() || this.selectedIndices.size === 0) return;
            for (const idx of this.selectedIndices) this.nodes[idx].isElevationTransition = false;
            this.updateUI();
            this.queueAutoSave();
        });
        document.getElementById('elevation-transition-btn')?.addEventListener('click', () => {
            if (!this.isBetaUser() || this.selectedIndices.size === 0) return;
            for (const idx of this.selectedIndices) this.nodes[idx].isElevationTransition = true;
            this.updateUI();
            this.queueAutoSave();
        });
        document.getElementById('elevation-datum-btn')?.addEventListener('click', () => {
            if (!this.isBetaUser() || this.selectedIndices.size === 0) return;
            for (const idx of this.selectedIndices) {
                this.nodes[idx].isElevationTransition = false;
                this.nodes[idx].elevation = 0;
            }
            this.updateUI();
            this.draw();
            this.queueAutoSave();
        });
        const view3dBtn = document.getElementById('view-3d-btn');
        if (view3dBtn) view3dBtn.onclick = () => this.launch3D();
        document.querySelectorAll('.corner-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const type = e.currentTarget.dataset.type;
                if (this.selectedIndices.size > 0) {
                    for (const idx of this.selectedIndices)
                        this.nodes[idx].type = type;
                    this.updateUI();
                    this.draw();
                    this.queueAutoSave();
                }
            });
        });

        // Point Width & Transition Listeners
        const nodeWidthRange = document.getElementById('node-width-range');
        const nodeWidthNum = document.getElementById('node-width-num');
        const nodeWidthFixedBtn = document.getElementById('node-width-fixed-btn');
        const nodeWidthGlobalBtn = document.getElementById('node-width-trans-btn');
        const nodeWidthTransitionBtn = document.getElementById('node-width-transition-btn');

        const applyPointWidth = (val) => {
            if (this.selectedIndices.size === 0) return;
            let num = parseFloat(val);
            if (isNaN(num) || num < MIN_TRACK_WIDTH) num = MIN_TRACK_WIDTH;
            for (const idx of this.selectedIndices) {
                this.nodes[idx].customWidth = num;
                this.nodes[idx].isTransition = false;
            }
            this.updateUI();
            this.draw();
            this.queueAutoSave();
        };

        nodeWidthRange?.addEventListener('input', (e) => {
            applyPointWidth(e.target.value);
        });

        nodeWidthNum?.addEventListener('change', (e) => {
            applyPointWidth(e.target.value);
        });

        nodeWidthFixedBtn?.addEventListener('click', () => {
            if (this.selectedIndices.size === 0) return;
            const currentVal = parseFloat(nodeWidthRange?.value) || this.trackWidth;
            applyPointWidth(currentVal);
        });

        nodeWidthTransitionBtn?.addEventListener('click', () => {
            if (this.selectedIndices.size === 0) return;
            for (const idx of this.selectedIndices) {
                this.nodes[idx].isTransition = true;
                this.nodes[idx].customWidth = null;
            }
            this.updateUI();
            this.draw();
            this.queueAutoSave();
        });

        nodeWidthGlobalBtn?.addEventListener('click', () => {
            if (this.selectedIndices.size === 0) return;
            for (const idx of this.selectedIndices) {
                this.nodes[idx].isTransition = false;
                this.nodes[idx].customWidth = null;
            }
            this.updateUI();
            this.draw();
            this.queueAutoSave();
        });

        document.getElementById('reset-tangents-btn').onclick = () => {
            if (this.selectedIndices.size > 0) {
                for (const idx of this.selectedIndices) {
                    this.nodes[idx].cpIn = null;
                    this.nodes[idx].cpOut = null;
                }
                this.draw();
                this.queueAutoSave();
            }
        };
        document.getElementById('delete-btn').onclick = () => {
            if (this.currentTool === 'pits' && this.selectedPitIndex !== -1) {
                this.pitNodes.splice(this.selectedPitIndex, 1);
                this.selectedPitIndex = -1;
                this.updateUI();
                this.draw();
                this.queueAutoSave();
                return;
            }
            if (this.selectedIndices.size > 0) {
                const indices = Array.from(this.selectedIndices).sort((a, b) => b - a);
                for (const idx of indices) {
                    this.nodes.splice(idx, 1);
                }
                this.selectedIndices.clear();
                this.draggedHandle = 'none';
                this.draggedNodeIdx = -1;
                this.updateUI();
                this.draw();
                this.queueAutoSave();
            }
        };
        document.getElementById('insert-point-btn').onclick = () => {
            if (this.currentTool === 'pits' && this.selectedPitIndex !== -1) {
                const idx = this.selectedPitIndex;
                const p1 = this.pitNodes[idx];
                if (this.pitNodes.length === 1 || idx === this.pitNodes.length - 1) {
                    this.pitNodes.push({ x: p1.x + 30, y: p1.y });
                    this.selectedPitIndex = this.pitNodes.length - 1;
                }
                else {
                    const p2 = this.pitNodes[idx + 1];
                    this.pitNodes.splice(idx + 1, 0, { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 });
                    this.selectedPitIndex = idx + 1;
                }
                this.updateUI();
                this.draw();
                this.queueAutoSave();
                return;
            }
            if (this.selectedIndices.size === 1) {
                const idx = Array.from(this.selectedIndices)[0];
                const n1 = this.nodes[idx];
                const nextIdx = (idx + 1) % this.nodes.length;
                const n2 = this.nodes[nextIdx];
                const mx = (n1.x + n2.x) / 2;
                const my = (n1.y + n2.y) / 2;
                const newNode = new TrackNode(mx, my);
                if (idx === this.nodes.length - 1 && !this.isClosedTrack) {
                    this.nodes.push(newNode);
                    this.selectedIndices.clear();
                    this.selectedIndices.add(this.nodes.length - 1);
                }
                else {
                    this.nodes.splice(idx + 1, 0, newNode);
                    this.selectedIndices.clear();
                    this.selectedIndices.add(idx + 1);
                }
                this.updateUI();
                this.draw();
                this.queueAutoSave();
            }
        };
        document.getElementById('clear-btn').onclick = () => { this.nodes = []; this.pitNodes = []; this.selectedIndices.clear(); this.isClosedTrack = false; document.getElementById('toggle-close-btn').classList.remove('toggle-closed'); this.updateCloseCircuitAvailability(); this.updateUI(); this.draw(); this.queueAutoSave(); };
        // Export Image
        document.getElementById('export-img-btn').onclick = () => this.exportImage();
        // Import JSON
        document.getElementById('import-json-btn').addEventListener('change', (e) => {
            var _a;
            const file = (_a = e.target.files) === null || _a === void 0 ? void 0 : _a[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = (re) => {
                    var _a;
                    try {
                        const data = JSON.parse((_a = re.target) === null || _a === void 0 ? void 0 : _a.result);
                        // Reset current track
                        this.nodes = [];
                        this.pitNodes = [];
                        this.selectedIndices.clear();
                        this.bgImage = null;
                        let nodesData = [];
                        // Check if new format or old array-only format
                        if (Array.isArray(data)) {
                            nodesData = data;
                        }
                        else if (data.nodes && Array.isArray(data.nodes)) {
                            nodesData = data.nodes;
                            if (Array.isArray(data.selectedTrackTags)) {
                                this.selectedTrackTags = this.normalizeTrackTags(data.selectedTrackTags);
                            }
                            if (data.selectedRallyFormat) {
                                this.selectedRallyFormat = data.selectedRallyFormat;
                            }
                            if (Array.isArray(data.pitNodes)) {
                                this.pitNodes = data.pitNodes.map((p) => ({ x: p.x, y: p.y }));
                            }
                            // Restore Background properties if they exist
                            if (data.bgImage) {
                                const img = new Image();
                                img.onload = () => {
                                    this.bgImage = img;
                                    document.getElementById('ai-trace-btn').classList.remove('hidden');
                                    this.draw();
                                };
                                img.src = data.bgImage;
                            }
                            if (data.bgScale !== undefined) {
                                this.bgScale = data.bgScale;
                                document.getElementById('bg-scale').value = (data.bgScale * 100).toString();
                                document.getElementById('bg-scale-val').innerText = `${data.bgScale.toFixed(1)}x`;
                            }
                            if (data.bgOpacity !== undefined) {
                                this.bgOpacity = data.bgOpacity;
                                document.getElementById('bg-opacity').value = (data.bgOpacity * 100).toString();
                                document.getElementById('bg-opacity-val').innerText = `${Math.round(data.bgOpacity * 100)}%`;
                            }
                        }
                        else {
                            return alert("Invalid circuit data format.");
                        }
                        this.nodes = nodesData.map((n) => {
                            const node = new TrackNode(n.x, n.y);
                            node.sharpness = n.sharpness || 0;
                            node.sector = n.sector || 1;
                            node.isDRS = n.isDRS || false;
                            node.type = n.type || 'straight';
                            node.elevation = n.elevation || 0;
                            node.isElevationTransition = !!n.isElevationTransition;
                            node.cpIn = n.cpIn ? { x: n.cpIn.x, y: n.cpIn.y } : null;
                            node.cpOut = n.cpOut ? { x: n.cpOut.x, y: n.cpOut.y } : null;
                            node.turnNumber = n.turnNumber || 0;
                            return node;
                        });
                        if (this.selectedTrackTags.length === 0 && this.membershipAccess.tags.length === 1) {
                            this.selectedTrackTags = [...this.membershipAccess.tags];
                        }
                        this.syncTrackClosureFromSelection();
                        this.renderTrackTagSelector();
                        this.renderSelectedTrackTags();
                        this.draw();
                        this.queueAutoSave();
                    }
                    catch (err) {
                        alert("Failed to parse JSON file.");
                        console.error(err);
                    }
                };
                reader.readAsText(file);
                e.target.value = ''; // Reset
            }
        });
        // Export JSON
        document.getElementById('export-json-btn').onclick = () => {
            // Extract background image dataURL if present
            let bgImageDataUrl = null;
            if (this.bgImage) {
                try {
                    const tempCanvas = document.createElement('canvas');
                    tempCanvas.width = this.bgImage.width;
                    tempCanvas.height = this.bgImage.height;
                    const tCtx = tempCanvas.getContext('2d');
                    tCtx.drawImage(this.bgImage, 0, 0);
                    bgImageDataUrl = tempCanvas.toDataURL('image/png');
                }
                catch (e) {
                    console.warn("Could not export background image due to CORS/Taint.", e);
                }
            }
            const exportData = {
                nodes: this.nodes,
                pitNodes: this.pitNodes,
                selectedTrackTags: this.selectedTrackTags,
                selectedRallyFormat: this.selectedRallyFormat,
                bgImage: bgImageDataUrl,
                bgScale: this.bgScale,
                bgOpacity: this.bgOpacity
            };
            if (!window.ApexNativeBridge.exportJSON('f1_circuit_data.json', exportData)) {
                const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportData));
                const dlAnchorElem = document.createElement('a');
                dlAnchorElem.setAttribute("href", dataStr);
                dlAnchorElem.setAttribute("download", "f1_circuit_data.json");
                dlAnchorElem.click();
            }


        };
        const raceBtn = document.getElementById('race-add-btn');
        if (raceBtn) {
            raceBtn.onclick = () => this.launchRace();
        }
    }
    launchRace() {
        if (!this.nodes || this.nodes.length < 2) {
            alert('Draw at least two track nodes before racing.');
            return;
        }
        // Persist current work so the race page reads fresh geometry.
        this.hasUnsavedChanges = true;
        this.saveProject();
        if (!this.currentProjectId) {
            alert('Save your track before racing.');
            return;
        }
        window.location.href = `race.html?id=${encodeURIComponent(this.currentProjectId)}`;
    }
    launch3D() {
        if (!this.isBetaUser()) {
            alert('The 3D elevation viewer is a beta feature for Apex Ultimate (all-access) members.');
            return;
        }
        if (!this.nodes || this.nodes.length < 2) {
            alert('Draw at least two track nodes before viewing in 3D.');
            return;
        }
        this.hasUnsavedChanges = true;
        this.saveProject();
        if (!this.currentProjectId) {
            alert('Save your track before viewing in 3D.');
            return;
        }
        window.location.href = `track3d.html?id=${encodeURIComponent(this.currentProjectId)}`;
    }
    setTool(tool) {
        this.currentTool = tool;
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('tool-active', b.id === `tool-${tool}`));
        this.updateUI();
        this.draw();
    }
    updateUI() {
        const inspector = document.getElementById('inspector');
        if (this.selectedIndices.size === 0 && this.selectedPitIndex === -1) {
            inspector.classList.add('hidden');
            return;
        }
        inspector.classList.remove('hidden');

        // Update inspector subtitle
        const subtitle = document.getElementById('inspector-subtitle');
        if (subtitle) {
            const count = this.selectedIndices.size;
            const total = this.nodes.length;
            if (count === 1) {
                const idx = Array.from(this.selectedIndices)[0];
                subtitle.textContent = `Point ${idx + 1} of ${total}`;
            } else if (count > 1) {
                subtitle.textContent = `${count} points selected`;
            } else {
                subtitle.textContent = 'Pit entry selected';
            }
        }

        if (this.currentTool === 'pits' && this.selectedPitIndex !== -1) {
            const insertBtn = document.getElementById('insert-point-btn');
            if (insertBtn) {
                insertBtn.disabled = false;
                insertBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
            return;
        }
        const firstIdx = Array.from(this.selectedIndices)[0];
        const n = this.nodes[firstIdx];
        document.getElementById('corner-radius').value = n.sharpness.toString();
        document.getElementById('val-angle').innerText = n.sharpness.toString();
        const elevInput = document.getElementById('elevation-range');
        if (elevInput) {
            const elev = n.elevation || 0;
            elevInput.value = elev.toString();
            const elevVal = document.getElementById('val-elevation');
            if (elevVal) elevVal.innerText = (elev > 0 ? '+' : '') + elev + ' m';
        }
        const elevationFixedBtn = document.getElementById('elevation-fixed-btn');
        const elevationTransitionBtn = document.getElementById('elevation-transition-btn');
        const elevationDatumBtn = document.getElementById('elevation-datum-btn');
        const elevationNote = document.getElementById('elevation-mode-note');
        const setElevationMode = (button, active) => {
            button?.classList.toggle('active', active);
            button?.classList.toggle('bg-cyan-600/20', active);
            button?.classList.toggle('text-cyan-100', active);
            button?.classList.toggle('bg-white/5', !active);
            button?.classList.toggle('text-white/60', !active);
        };
        if (n.isElevationTransition) {
            setElevationMode(elevationFixedBtn, false);
            setElevationMode(elevationTransitionBtn, true);
            setElevationMode(elevationDatumBtn, false);
            elevInput?.classList.add('opacity-40', 'pointer-events-none');
            if (elevationNote) elevationNote.textContent = 'Transition blends this point between its nearest fixed heights.';
        } else if ((n.elevation || 0) === 0) {
            setElevationMode(elevationFixedBtn, false);
            setElevationMode(elevationTransitionBtn, false);
            setElevationMode(elevationDatumBtn, true);
            elevInput?.classList.remove('opacity-40', 'pointer-events-none');
            if (elevationNote) elevationNote.textContent = 'This point uses the datum height (0 m).';
        } else {
            setElevationMode(elevationFixedBtn, true);
            setElevationMode(elevationTransitionBtn, false);
            setElevationMode(elevationDatumBtn, false);
            elevInput?.classList.remove('opacity-40', 'pointer-events-none');
            if (elevationNote) elevationNote.textContent = 'Fixed height affects this point and blends into neighbouring segments.';
        }
        document.querySelectorAll('.corner-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.type === n.type);
        });

        // Point Track Width & Transition UI state
        const widthValEl = document.getElementById('node-width-val');
        const widthRange = document.getElementById('node-width-range');
        const widthNum = document.getElementById('node-width-num');
        const fixedBtn = document.getElementById('node-width-fixed-btn');
        const globalBtn = document.getElementById('node-width-trans-btn');
        const transitionBtn = document.getElementById('node-width-transition-btn');
        const modeNote = document.getElementById('node-width-mode-note');
        const sliderWrap = document.getElementById('node-width-slider-wrap');

        const resolvedWidths = this.getNodeWidths();
        const currentEffectiveW = Math.round(resolvedWidths[firstIdx] || this.trackWidth);

        if (widthValEl) widthValEl.innerText = `${currentEffectiveW} px`;

        if (n.isTransition) {
            fixedBtn?.classList.remove('active', 'bg-purple-600/20', 'text-purple-200');
            fixedBtn?.classList.add('bg-white/5', 'text-white/60');
            globalBtn?.classList.remove('active', 'bg-purple-600/20', 'text-purple-200');
            globalBtn?.classList.add('bg-white/5', 'text-white/60');
            transitionBtn?.classList.add('active', 'bg-purple-600/20', 'text-purple-200');
            transitionBtn?.classList.remove('bg-white/5', 'text-white/60');
            sliderWrap?.classList.add('opacity-40', 'pointer-events-none');
            if (modeNote) modeNote.textContent = 'Transition blends this point between its nearest fixed-width points.';
            if (widthRange) widthRange.value = currentEffectiveW.toString();
            if (widthNum) widthNum.value = currentEffectiveW.toString();
        } else if (n.customWidth !== null && n.customWidth !== undefined) {
            fixedBtn?.classList.add('active', 'bg-purple-600/20', 'text-purple-200');
            fixedBtn?.classList.remove('bg-white/5', 'text-white/60');
            globalBtn?.classList.remove('active', 'bg-purple-600/20', 'text-purple-200');
            globalBtn?.classList.add('bg-white/5', 'text-white/60');
            transitionBtn?.classList.remove('active', 'bg-purple-600/20', 'text-purple-200');
            transitionBtn?.classList.add('bg-white/5', 'text-white/60');
            sliderWrap?.classList.remove('opacity-40', 'pointer-events-none');
            if (modeNote) modeNote.textContent = 'Fixed width affects this point and tapers into the neighbouring segments.';
            if (widthRange) widthRange.value = n.customWidth.toString();
            if (widthNum) widthNum.value = n.customWidth.toString();
        } else {
            fixedBtn?.classList.remove('active', 'bg-purple-600/20', 'text-purple-200');
            fixedBtn?.classList.add('bg-white/5', 'text-white/60');
            globalBtn?.classList.add('active', 'bg-purple-600/20', 'text-purple-200');
            globalBtn?.classList.remove('bg-white/5', 'text-white/60');
            transitionBtn?.classList.remove('active', 'bg-purple-600/20', 'text-purple-200');
            transitionBtn?.classList.add('bg-white/5', 'text-white/60');
            sliderWrap?.classList.remove('opacity-40', 'pointer-events-none');
            if (modeNote) modeNote.textContent = 'This point uses the global track width and has no local override.';
            if (widthRange) widthRange.value = this.trackWidth.toString();
            if (widthNum) widthNum.value = this.trackWidth.toString();
        }

        const insertBtn = document.getElementById('insert-point-btn');
        if (insertBtn) {
            if (this.selectedIndices.size === 1) {
                insertBtn.disabled = false;
                insertBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
            else {
                insertBtn.disabled = true;
                insertBtn.classList.add('opacity-50', 'cursor-not-allowed');
            }
        }
    }
    async autoTraceTrack() {
        if (!this.bgImage)
            return;
        const overlay = document.getElementById('ai-trace-overlay');
        const statusEl = document.getElementById('trace-status');
        const barEl = document.getElementById('trace-progress-bar');
        const pctEl = document.getElementById('trace-progress-pct');
        const setProgress = (pct, status) => {
            barEl.style.width = `${pct}%`;
            pctEl.innerText = `${Math.round(pct)}%`;
            statusEl.innerText = status;
        };
        overlay.classList.remove('hidden');
        setProgress(0, 'PREPARING SENSORS...');
        await new Promise(r => setTimeout(r, 80));
        // 1. DOWNSAMPLE & PRE-PROCESS
        const MAX_DIM = 600;
        const origW = this.bgImage.width * this.bgScale;
        const origH = this.bgImage.height * this.bgScale;
        const scaleFactor = Math.min(1, MAX_DIM / Math.max(origW, origH));
        const tc = document.createElement('canvas');
        tc.width = Math.floor(origW * scaleFactor);
        tc.height = Math.floor(origH * scaleFactor);
        const tx = tc.getContext('2d', { willReadFrequently: true });
        tx.drawImage(this.bgImage, 0, 0, tc.width, tc.height);
        const imgData = tx.getImageData(0, 0, tc.width, tc.height);
        const data = imgData.data;
        const W = tc.width;
        const H = tc.height;
        // Grayscale/Luma conversion helper
        const getLuma = (x, y) => {
            if (x < 0 || x >= W || y < 0 || y >= H)
                return 255;
            const i = (Math.round(y) * W + Math.round(x)) * 4;
            if (data[i + 3] < 50)
                return 255; // Transparent is background
            return (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
        };
        setProgress(15, 'LOCATION SEEDING...');
        await new Promise(r => setTimeout(r, 60));
        // 2. FIND SEED (Darkest spot)
        let minLuma = 255;
        let seedX = 0, seedY = 0;
        for (let y = 5; y < H - 5; y += 4) {
            for (let x = 5; x < W - 5; x += 4) {
                const l = getLuma(x, y);
                if (l < minLuma) {
                    minLuma = l;
                    seedX = x;
                    seedY = y;
                }
            }
        }
        if (minLuma > 200) {
            overlay.classList.add('hidden');
            alert('AI could not identify a track signature. Use higher contrast imagery.');
            return;
        }
        setProgress(30, 'CALIBRATING PATH...');
        await new Promise(r => setTimeout(r, 60));
        // 3. WALK-ALONG ALGORITHM
        // Strategy: From current point, look in a small arc around the current heading.
        // Find the darkest local "neighborhood" and move there.
        const walkPath = [];
        let curX = seedX, curY = seedY;
        let heading = 0; // Current walking angle
        const stepLen = 4; // Pixels per walk step
        const maxSteps = 2000;
        // Track visited pixels to prevent infinite loops (simple grid)
        const visited = new Uint8Array(W * H);
        const markVisited = (x, y) => {
            const ix = Math.floor(x), iy = Math.floor(y);
            if (ix >= 0 && ix < W && iy >= 0 && iy < H)
                visited[iy * W + ix] = 1;
        };
        const checkVisited = (x, y) => {
            const ix = Math.floor(x), iy = Math.floor(y);
            if (ix < 0 || ix >= W || iy < 0 || iy >= H)
                return true;
            return visited[iy * W + ix] === 1;
        };
        // Determine initial heading by looking around the seed
        let bestHeading = 0;
        let bestHeadingLuma = 255;
        for (let a = 0; a < Math.PI * 2; a += 0.2) {
            const lx = curX + Math.cos(a) * 8, ly = curY + Math.sin(a) * 8;
            const l = getLuma(lx, ly);
            if (l < bestHeadingLuma) {
                bestHeadingLuma = l;
                bestHeading = a;
            }
        }
        heading = bestHeading;
        for (let step = 0; step < maxSteps; step++) {
            if (step % 50 === 0) {
                setProgress(30 + (step / maxSteps) * 60, `TRACING SEGMENT ${step}...`);
                await new Promise(r => setTimeout(r, 0));
            }
            walkPath.push({ x: curX, y: curY });
            markVisited(curX, curY);
            // Scan a 120-degree cone ahead
            let bestX = curX, bestY = curY;
            let bestL = 255;
            let winnerAngle = heading;
            // Multi-sample lookahead for robustness
            for (let da = -1.2; da <= 1.2; da += 0.15) {
                const a = heading + da;
                // Look at several distances to avoid local noise
                let localSum = 0;
                for (let d = 2; d <= 6; d += 2) {
                    localSum += getLuma(curX + Math.cos(a) * d, curY + Math.sin(a) * d);
                }
                const avgL = localSum / 3;
                if (avgL < bestL) {
                    bestL = avgL;
                    winnerAngle = a;
                }
            }
            // Move
            heading = winnerAngle;
            curX += Math.cos(heading) * stepLen;
            curY += Math.sin(heading) * stepLen;
            // Stop conditions
            // 1. Return to seed
            if (step > 40 && Math.hypot(curX - seedX, curY - seedY) < 10) {
                break;
            }
            // 2. Out of bounds or too light
            if (curX < 0 || curX >= W || curY < 0 || curY >= H || getLuma(curX, curY) > 220) {
                break;
            }
        }
        if (walkPath.length < 30) {
            overlay.classList.add('hidden');
            alert('Target too small or contrast too low for Walk-Trace.');
            return;
        }
        setProgress(90, 'SMOOTHING TRAJECTORY...');
        await new Promise(r => setTimeout(r, 100));
        // 4. LAPLACIAN SMOOTHING & SUBSAMPLING
        const rawPts = walkPath;
        const iterations = 5;
        for (let iter = 0; iter < iterations; iter++) {
            for (let i = 1; i < rawPts.length - 1; i++) {
                rawPts[i].x = (rawPts[i - 1].x + rawPts[i].x + rawPts[i + 1].x) / 3;
                rawPts[i].y = (rawPts[i - 1].y + rawPts[i].y + rawPts[i + 1].y) / 3;
            }
        }
        // Subsample to 40 nodes
        this.nodes = [];
        const targetNodeCount = 40;
        const stride = Math.floor(rawPts.length / targetNodeCount);
        const invScale = 1 / scaleFactor;
        for (let i = 0; i < rawPts.length; i += stride) {
            const p = rawPts[i];
            this.nodes.push(new TrackNode(p.x * invScale, p.y * invScale));
        }
        this.isClosedTrack = true;
        this.syncTrackClosureFromSelection();
        this.updateCloseCircuitAvailability();
        setProgress(100, 'ENGINEERING COMPLETE!');
        await new Promise(r => setTimeout(r, 600));
        overlay.classList.add('hidden');
        this.updateUI();
        this.draw();
    }
    exportImage() {
        if (this.nodes.length < 2)
            return;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        this.nodes.forEach(n => {
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x);
            maxY = Math.max(maxY, n.y);
        });
        const padding = 150;
        minX -= padding;
        minY -= padding;
        maxX += padding;
        maxY += padding;
        const width = maxX - minX;
        const height = maxY - minY;
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = width;
        exportCanvas.height = height;
        const ectx = exportCanvas.getContext('2d');
        ectx.fillStyle = '#0b0e14';
        ectx.fillRect(0, 0, width, height);
        // Also draw background image if it exists
        if (this.bgImage) {
            ectx.globalAlpha = this.bgOpacity;
            ectx.drawImage(this.bgImage, -minX * this.scale, -minY * this.scale, this.bgImage.width * this.scale, this.bgImage.height * this.scale);
            ectx.globalAlpha = 1.0;
        }
        ectx.save();
        ectx.translate(-minX, -minY);
        this.renderTrack(ectx, '#1e293b', false);
        this.renderTrack(ectx, '', true);
        ectx.restore();
        const link = document.createElement('a');
        link.download = 'circuit_layout.png';
        link.href = exportCanvas.toDataURL('image/png');
        if (!window.ApexNativeBridge.exportPNG('circuit_layout.png', link.href)) {
            link.click();
        }
    }
    getBezierPoint(t, p0, c0, c1, p1) {
        const mt = 1 - t;
        const mt2 = mt * mt;
        const mt3 = mt2 * mt;
        const t2 = t * t;
        const t3 = t2 * t;
        return {
            x: p0.x * mt3 + 3 * c0.x * mt2 * t + 3 * c1.x * mt * t2 + p1.x * t3,
            y: p0.y * mt3 + 3 * c0.y * mt2 * t + 3 * c1.y * mt * t2 + p1.y * t3
        };
    }
    getBezierDerivative(t, p0, c0, c1, p1) {
        const mt = 1 - t;
        const mt2 = mt * mt;
        const t2 = t * t;
        return {
            x: 3 * mt2 * (c0.x - p0.x) + 6 * mt * t * (c1.x - c0.x) + 3 * t2 * (p1.x - c1.x),
            y: 3 * mt2 * (c0.y - p0.y) + 6 * mt * t * (c1.y - c0.y) + 3 * t2 * (p1.y - c1.y)
        };
    }
    getBezierNormal(t, p0, c0, c1, p1) {
        const d = this.getBezierDerivative(t, p0, c0, c1, p1);
        const len = Math.hypot(d.x, d.y) || 1;
        // Normal is (-dy, dx)
        return { x: -d.y / len, y: d.x / len };
    }
    draw() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        this.ctx.save();
        this.ctx.translate(this.offset.x, this.offset.y);
        this.ctx.scale(this.scale, this.scale);
        if (this.bgImage) {
            this.ctx.globalAlpha = this.bgOpacity;
            this.ctx.drawImage(this.bgImage, 0, 0, this.bgImage.width * this.bgScale, this.bgImage.height * this.bgScale);
            this.ctx.globalAlpha = 1.0;
        }
        this.drawGrid();
        if (this.nodes.length > 1) {
            this.renderTrack(this.ctx, '#1e293b', false);
            this.renderTrack(this.ctx, '', true);
        }
        this.renderPitLane(this.ctx);
        if (this.isBoxSelecting && this.selectionBox) {
            this.ctx.fillStyle = 'rgba(225, 6, 0, 0.1)';
            this.ctx.strokeStyle = '#e10600';
            this.ctx.lineWidth = 1 / this.scale;
            const x = Math.min(this.selectionBox.start.x, this.selectionBox.end.x);
            const y = Math.min(this.selectionBox.start.y, this.selectionBox.end.y);
            const w = Math.abs(this.selectionBox.start.x - this.selectionBox.end.x);
            const h = Math.abs(this.selectionBox.start.y - this.selectionBox.end.y);
            this.ctx.fillRect(x, y, w, h);
            this.ctx.strokeRect(x, y, w, h);
        }
        // Markers
        const nodeWidths = this.getNodeWidths();
        this.nodes.forEach((n, i) => {
            const active = this.selectedIndices.has(i);
            const resolvedW = Math.round(nodeWidths[i] || this.trackWidth);

            // Width indicator ring on active or customized nodes
            if (n.customWidth !== null && !n.isTransition) {
                this.ctx.save();
                this.ctx.strokeStyle = 'rgba(192, 132, 252, 0.8)';
                this.ctx.lineWidth = 2 / this.scale;
                this.ctx.beginPath();
                this.ctx.arc(n.x, n.y, (resolvedW / 2) / this.scale, 0, Math.PI * 2);
                this.ctx.stroke();
                this.ctx.restore();
            } else if (n.isTransition) {
                this.ctx.save();
                this.ctx.strokeStyle = 'rgba(192, 132, 252, 0.5)';
                this.ctx.lineWidth = 1.5 / this.scale;
                this.ctx.setLineDash([4 / this.scale, 4 / this.scale]);
                this.ctx.beginPath();
                this.ctx.arc(n.x, n.y, (resolvedW / 2) / this.scale, 0, Math.PI * 2);
                this.ctx.stroke();
                this.ctx.restore();
            }

            if (this.currentTool === 'tangent' && active) {
                const ctrls = this.getCtrlPts(i);
                this.ctx.strokeStyle = '#a855f7';
                this.ctx.lineWidth = 2 / this.scale;
                this.ctx.beginPath();
                this.ctx.moveTo(ctrls.pIn.x, ctrls.pIn.y);
                this.ctx.lineTo(n.x, n.y);
                this.ctx.lineTo(ctrls.pOut.x, ctrls.pOut.y);
                this.ctx.stroke();
                this.ctx.fillStyle = '#a855f7';
                this.ctx.beginPath();
                this.ctx.arc(ctrls.pIn.x, ctrls.pIn.y, 4 / this.scale, 0, Math.PI * 2);
                this.ctx.fill();
                this.ctx.beginPath();
                this.ctx.arc(ctrls.pOut.x, ctrls.pOut.y, 4 / this.scale, 0, Math.PI * 2);
                this.ctx.fill();
            }
            this.ctx.fillStyle = active ? '#e10600' : 'rgba(255,255,255,0.8)';
            this.ctx.beginPath();
            this.ctx.arc(n.x, n.y, 6 / this.scale, 0, Math.PI * 2);
            this.ctx.fill();
            if (active) {
                this.ctx.strokeStyle = 'rgba(225, 6, 0, 0.4)';
                this.ctx.lineWidth = 4 / this.scale;
                this.ctx.beginPath();
                this.ctx.arc(n.x, n.y, 12 / this.scale, 0, Math.PI * 2);
                this.ctx.stroke();
            }

            // Node label with custom width badge
            let labelText = `P${i + 1}`;
            if (n.customWidth !== null && !n.isTransition) {
                labelText += ` [${n.customWidth}px]`;
            } else if (n.isTransition) {
                labelText += ` [⇄]`;
            }

            this.ctx.fillStyle = (n.customWidth !== null || n.isTransition) ? '#c084fc' : 'rgba(255,255,255,0.7)';
            this.ctx.font = `bold ${11 / this.scale}px Orbitron`;
            this.ctx.textAlign = 'center';
            this.ctx.fillText(labelText, n.x, n.y - (18 / this.scale));
            if (n.turnNumber > 0) {
                const turnStr = n.turnNumber.toString().padStart(2, '0');
                const offset = 24 / this.scale;
                const markerX = n.x + offset;
                const markerY = n.y - offset;
                
                this.ctx.fillStyle = 'white';
                this.ctx.beginPath();
                this.ctx.arc(markerX, markerY, 10 / this.scale, 0, Math.PI * 2);
                this.ctx.fill();
                
                this.ctx.fillStyle = 'black';
                this.ctx.font = `bold ${10 / this.scale}px Inter`;
                this.ctx.textAlign = 'center';
                this.ctx.textBaseline = 'middle';
                this.ctx.fillText(turnStr, markerX, markerY);
                this.ctx.textBaseline = 'alphabetic';
            }
        });
        this.pitNodes.forEach((p, i) => {
            const active = this.selectedPitIndex === i;
            this.ctx.fillStyle = active ? '#f59e0b' : 'rgba(245,158,11,0.8)';
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, 5 / this.scale, 0, Math.PI * 2);
            this.ctx.fill();
            if (active) {
                this.ctx.strokeStyle = 'rgba(245,158,11,0.45)';
                this.ctx.lineWidth = 4 / this.scale;
                this.ctx.beginPath();
                this.ctx.arc(p.x, p.y, 11 / this.scale, 0, Math.PI * 2);
                this.ctx.stroke();
            }
        });
        this.ctx.restore();
        this.updateStats();
    }
    drawGrid() {
        const sz = 100;
        const sX = Math.floor(-this.offset.x / this.scale / sz) * sz, sY = Math.floor(-this.offset.y / this.scale / sz) * sz;
        this.ctx.beginPath();
        this.ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        for (let x = sX; x < sX + this.canvas.width / this.scale + sz; x += sz) {
            this.ctx.moveTo(x, sY);
            this.ctx.lineTo(x, sY + this.canvas.height / this.scale + sz);
        }
        for (let y = sY; y < sY + this.canvas.height / this.scale + sz; y += sz) {
            this.ctx.moveTo(sX, y);
            this.ctx.lineTo(sX + this.canvas.width / this.scale + sz, y);
        }
        this.ctx.stroke();
    }
    getNodeWidths() {
        const baseWidth = Math.max(MIN_TRACK_WIDTH, this.trackWidth || 36);

        // A custom width belongs only to that node. Rendering interpolates between
        // neighboring node values, so a local change tapers into the adjacent
        // segments without changing the rest of the circuit.
        const resolved = this.nodes.map((node) => {
            if (node.customWidth !== null && node.customWidth !== undefined && !node.isTransition) {
                return Math.max(MIN_TRACK_WIDTH, Number(node.customWidth) || baseWidth);
            }
            return baseWidth;
        });

        const findFixedPoint = (startIndex, direction) => {
            for (let distance = 1; distance < this.nodes.length; distance++) {
                let index = startIndex + distance * direction;
                if (!this.isClosedTrack && (index < 0 || index >= this.nodes.length)) return null;
                index = (index + this.nodes.length) % this.nodes.length;
                const node = this.nodes[index];
                if (node.customWidth !== null && node.customWidth !== undefined && !node.isTransition) {
                    return { index, distance, width: resolved[index] };
                }
            }
            return null;
        };

        // Only points explicitly marked Transition blend between nearby fixed points.
        // Normal points always keep the global width, even when another point is custom.
        this.nodes.forEach((node, index) => {
            if (!node.isTransition) return;
            const previous = findFixedPoint(index, -1);
            const next = findFixedPoint(index, 1);
            if (!previous || !next || previous.index === next.index) return;
            const ratio = previous.distance / (previous.distance + next.distance);
            const smoothRatio = ratio * ratio * (3 - 2 * ratio);
            resolved[index] = Math.max(
                MIN_TRACK_WIDTH,
                previous.width + (next.width - previous.width) * smoothRatio
            );
        });

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

    renderTrack(context, color, useSectors) {
        context.lineCap = 'round';
        context.lineJoin = 'round';
        const len = this.nodes.length;
        const endLoop = this.isClosedTrack ? len : len - 1;
        const steps = 30;

        for (let i = 0; i < endLoop; i++) {
            const idxThis = i;
            const idxNext = (i + 1) % len;
            const p1 = this.nodes[idxThis];
            const p2 = this.nodes[idxNext];
            const c1 = this.getCtrlPts(idxThis).pOut;
            const c2 = this.getCtrlPts(idxNext).pIn;
            const strokeColor = useSectors ? (['', '#ef4444', '#3b82f6', '#facc15'][p1.sector] || '#3b82f6') : color;

            context.strokeStyle = strokeColor;

            for (let s = 0; s < steps; s++) {
                const t1 = s / steps;
                const t2 = (s + 1) / steps;
                const pos1 = this.getBezierPoint(t1, p1, c1, c2, p2);
                const pos2 = this.getBezierPoint(t2, p1, c1, c2, p2);
                const w = this.getWidthAt(i, (t1 + t2) / 2);

                context.lineWidth = useSectors ? Math.max(4, w * 0.45) : w;
                context.beginPath();
                context.moveTo(pos1.x, pos1.y);
                context.lineTo(pos2.x, pos2.y);
                context.stroke();
            }

            // Parallel DRS Line calculation
            if (useSectors && p1.isDRS) {
                context.save();
                context.strokeStyle = '#22c55e';
                context.lineWidth = 4;
                context.setLineDash([12, 12]);
                context.beginPath();
                for (let s = 0; s <= steps; s++) {
                    const t = s / steps;
                    const pos = this.getBezierPoint(t, p1, c1, c2, p2);
                    const normal = this.getBezierNormal(t, p1, c1, c2, p2);
                    const w = this.getWidthAt(i, t);
                    const offsetDist = (w / 2) + 8;
                    const ox = pos.x + normal.x * offsetDist;
                    const oy = pos.y + normal.y * offsetDist;
                    if (s === 0)
                        context.moveTo(ox, oy);
                    else
                        context.lineTo(ox, oy);
                }
                context.stroke();
                context.restore();
            }
        }
    }
    renderPitLane(context) {
        if (this.pitNodes.length < 2)
            return;
        context.save();
        context.strokeStyle = '#f59e0b';
        context.lineWidth = 8;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.setLineDash([14, 8]);
        context.beginPath();
        const len = this.pitNodes.length;
        context.moveTo(this.pitNodes[0].x, this.pitNodes[0].y);
        for (let i = 0; i < len - 1; i++) {
            const p0 = i > 0 ? this.pitNodes[i - 1] : { x: this.pitNodes[0].x - (this.pitNodes[1].x - this.pitNodes[0].x), y: this.pitNodes[0].y - (this.pitNodes[1].y - this.pitNodes[0].y) };
            const p1 = this.pitNodes[i];
            const p2 = this.pitNodes[i + 1];
            const p3 = i < len - 2 ? this.pitNodes[i + 2] : { x: p2.x + (p2.x - p1.x), y: p2.y + (p2.y - p1.y) };

            const tx1 = (p2.x - p0.x) / 6;
            const ty1 = (p2.y - p0.y) / 6;
            const tx2 = (p3.x - p1.x) / 6;
            const ty2 = (p3.y - p1.y) / 6;

            const cp1x = p1.x + tx1;
            const cp1y = p1.y + ty1;
            const cp2x = p2.x - tx2;
            const cp2y = p2.y - ty2;

            context.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
        context.stroke();
        context.restore();
    }
    setTrackWidth(val, skipSave = false) {
        let num = parseFloat(val);
        const warning = document.getElementById('width-min-warning');
        if (isNaN(num) || num < MIN_TRACK_WIDTH) {
            num = MIN_TRACK_WIDTH;
            if (warning) warning.classList.remove('hidden');
        } else {
            if (warning) warning.classList.add('hidden');
        }
        this.trackWidth = num;
        const slider = document.getElementById('track-width-slider');
        const input = document.getElementById('track-width-input');
        if (slider && parseFloat(slider.value) !== num) slider.value = num.toString();
        if (input && parseFloat(input.value) !== num) input.value = num.toString();
        this.draw();
        if (!skipSave) this.queueAutoSave();
    }
    rescaleTrackGeometry(targetLength) {
        const inputVal = targetLength !== undefined ? targetLength : document.getElementById('target-length-input')?.value;
        if (!inputVal) return;
        const parsed = parseFloat(inputVal);
        if (isNaN(parsed) || parsed <= 0 || this.nodes.length < 2) return;

        const currentLen = this.getTrackLengthKM();
        if (currentLen <= 0) return;

        let targetKM = parsed;
        if (this.scaleUnit === 'm') targetKM = parsed / 1000;
        if (this.scaleUnit === 'cm') targetKM = parsed / 100000;

        const ratio = targetKM / currentLen;
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
        for (const p of this.pitNodes) {
            p.x = cx + (p.x - cx) * ratio;
            p.y = cy + (p.y - cy) * ratio;
        }

        this.draw();
        this.queueAutoSave();
        this.updateStats();
    }
    updateTargetLength(customVal) {
        const inputVal = customVal !== undefined ? customVal : document.getElementById('target-length-input')?.value;
        if (!inputVal)
            return;
        const targetLength = parseFloat(inputVal);
        if (isNaN(targetLength) || targetLength <= 0)
            return;
        // Recalculate pixels per unit based on the current unscaled track length
        let unscaledPixelLength = 0;
        const len = this.nodes.length;
        const endLoop = this.isClosedTrack ? len : len - 1;
        for (let i = 0; i < endLoop; i++) {
            const pts = 20;
            for (let s = 0; s < pts; s++) {
                const t1 = s / pts;
                const t2 = (s + 1) / pts;
                const p1 = this.nodes[i];
                const p2 = this.nodes[(i + 1) % len];
                const c1 = this.getCtrlPts(i).pOut;
                const c2 = this.getCtrlPts((i + 1) % len).pIn;
                const pos1 = this.getBezierPoint(t1, p1, c1, c2, p2);
                const pos2 = this.getBezierPoint(t2, p1, c1, c2, p2);
                unscaledPixelLength += Math.hypot(pos2.x - pos1.x, pos2.y - pos1.y);
            }
        }
        if (unscaledPixelLength > 0) {
            // targetLength = unscaledPixelLength / this.pxPerUnit
            // therefore: this.pxPerUnit = unscaledPixelLength / targetLength
            this.pxPerUnit = unscaledPixelLength / targetLength;
            const pxUnitSlider = document.getElementById('px-unit');
            const pxUnitVal = document.getElementById('px-unit-val');
            if (pxUnitSlider) pxUnitSlider.value = this.pxPerUnit.toString();
            if (pxUnitVal) pxUnitVal.innerText = `${Math.round(this.pxPerUnit)} px`;
            this.draw();
            this.updateStats();
        }
    }
    analyzeTrackSegments() {
        const len = this.nodes.length;
        if (len < 2)
            return alert("AI Needs at least 2 points to analyze the track segments.");
        const endLoop = this.isClosedTrack ? len : len - 1;
        let report = "--- AI TRACK SEGMENT TELEMETRY ---\n\n";
        let totalDist = 0;
        for (let i = 0; i < endLoop; i++) {
            const p1 = this.nodes[i];
            const p2 = this.nodes[(i + 1) % len];
            const pPrev = this.nodes[(i - 1 + len) % len];
            
            let angleDeg = 0;
            if (pPrev && p2) {
                const dx1 = p1.x - pPrev.x;
                const dy1 = p1.y - pPrev.y;
                const dx2 = p2.x - p1.x;
                const dy2 = p2.y - p1.y;
                
                const dot = dx1 * dx2 + dy1 * dy2;
                const mag1 = Math.hypot(dx1, dy1);
                const mag2 = Math.hypot(dx2, dy2);
                if (mag1 > 0 && mag2 > 0) {
                    const cosA = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
                    angleDeg = Math.acos(cosA) * (180 / Math.PI);
                }
            }
            
            let segmentDist = 0;
            const pts = 20;
            for (let s = 0; s < pts; s++) {
                const t1 = s / pts;
                const t2 = (s + 1) / pts;
                const c1 = this.getCtrlPts(i).pOut;
                const c2 = this.getCtrlPts((i + 1) % len).pIn;
                const pos1 = this.getBezierPoint(t1, p1, c1, c2, p2);
                const pos2 = this.getBezierPoint(t2, p1, c1, c2, p2);
                segmentDist += Math.hypot(pos2.x - pos1.x, pos2.y - pos1.y);
            }
            const physicalLength = segmentDist / this.pxPerUnit;
            totalDist += physicalLength;
            
            let detectedShape = 'Straight';
            let speedZone = 'Full Throttle';
            if (angleDeg > 135) {
                detectedShape = 'Hairpin';
                speedZone = 'Heavy Braking';
            } else if (angleDeg > 90) {
                detectedShape = 'Sharp Corner';
                speedZone = 'Slow Speed';
            } else if (angleDeg > 45) {
                detectedShape = 'Medium Corner';
                speedZone = 'Medium Speed';
            } else if (angleDeg > 15) {
                detectedShape = 'Gentle Sweep';
                speedZone = 'High Speed';
            } else if (angleDeg > 0) {
                detectedShape = 'Kink';
            }
            
            report += `Segment ${i + 1} - Length: ${physicalLength.toFixed(2)} ${this.scaleUnit.toUpperCase()}\n`;
            report += `  ↳ Geometry: ${detectedShape} (Curve: ${Math.round(angleDeg)}°)\n`;
            report += `  ↳ Estimated Speed: ${speedZone}\n\n`;
        }
        report += `Total AI Calculated Track Length: ${totalDist.toFixed(2)} ${this.scaleUnit.toUpperCase()}`;
        alert(report);
    }
    getTrackLengthKM() {
        let d = 0;
        const len = this.nodes.length;
        const endLoop = this.isClosedTrack ? len : len - 1;
        for (let i = 0; i < endLoop; i++) {
            const pts = 20;
            for (let s = 0; s < pts; s++) {
                const t1 = s / pts;
                const t2 = (s + 1) / pts;
                const p1 = this.nodes[i];
                const p2 = this.nodes[(i + 1) % len];
                const c1 = this.getCtrlPts(i).pOut;
                const c2 = this.getCtrlPts((i + 1) % len).pIn;
                const pos1 = this.getBezierPoint(t1, p1, c1, c2, p2);
                const pos2 = this.getBezierPoint(t2, p1, c1, c2, p2);
                d += Math.hypot(pos2.x - pos1.x, pos2.y - pos1.y);
            }
        }
        const totalUnits = d / this.pxPerUnit;
        if (this.scaleUnit === 'm') return totalUnits / 1000;
        if (this.scaleUnit === 'cm') return totalUnits / 100000;
        return totalUnits;
    }
    updateStats() {
        let d = 0;
        let numCorners = 0;
        const len = this.nodes.length;
        const endLoop = this.isClosedTrack ? len : len - 1;
        for (let i = 0; i < endLoop; i++) {
            const pts = 20;
            if (this.nodes[i].type !== 'straight')
                numCorners++;
            for (let s = 0; s < pts; s++) {
                const t1 = s / pts;
                const t2 = (s + 1) / pts;
                const p1 = this.nodes[i];
                const p2 = this.nodes[(i + 1) % len];
                const c1 = this.getCtrlPts(i).pOut;
                const c2 = this.getCtrlPts((i + 1) % len).pIn;
                const pos1 = this.getBezierPoint(t1, p1, c1, c2, p2);
                const pos2 = this.getBezierPoint(t2, p1, c1, c2, p2);
                // Dist in pixels
                d += Math.hypot(pos2.x - pos1.x, pos2.y - pos1.y);
            }
        }
        // Calculate physical distance
        const totalUnits = d / this.pxPerUnit;
        let distKM = totalUnits;
        if (this.scaleUnit === 'm') distKM = totalUnits / 1000;
        if (this.scaleUnit === 'cm') distKM = totalUnits / 100000;

        const lengthEl = document.getElementById('track-length');
        const limitWarning = document.getElementById('length-limit-warning');
        const lengthRule = this.getActiveLengthRule();
        const isBelowMin = this.selectedTrackTags.length > 0 && distKM > 0 && distKM < lengthRule.min;
        const isAboveMax = distKM > lengthRule.max;

        lengthEl.innerText = `${totalUnits.toFixed(2)} ${this.scaleUnit.toUpperCase()}`;
        lengthEl.title = this.getLengthLimitMessage();

        if (isAboveMax) {
            lengthEl.classList.add('text-red-500');
            lengthEl.classList.remove('text-white', 'text-amber-400');
            if (limitWarning) {
                limitWarning.textContent = `Too long. ${this.getLengthLimitMessage()}`;
                limitWarning.classList.remove('hidden');
            }
        } else if (isBelowMin) {
            lengthEl.classList.add('text-amber-400');
            lengthEl.classList.remove('text-white', 'text-red-500');
            if (limitWarning) {
                limitWarning.textContent = `Too short. ${this.getLengthLimitMessage()}`;
                limitWarning.classList.remove('hidden');
            }
        } else {
            lengthEl.classList.remove('text-red-500', 'text-amber-400');
            lengthEl.classList.add('text-white');
            if (limitWarning) limitWarning.classList.add('hidden');
        }

        const miniLen = document.getElementById('current-length-mini');
        if (miniLen) miniLen.innerText = `${totalUnits.toFixed(2)} ${this.scaleUnit.toUpperCase()}`;

        this.updateAITrackSuggestion(totalUnits, this.scaleUnit, numCorners);
    }
    // Project Management Methods
    generateId() {
        if (crypto && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    getAllProjects() {
        try {
            const stored = window.ApexNativeBridge.getItem(this.STORAGE_KEY);
            return stored ? JSON.parse(stored) : [];
        }
        catch (e) {
            console.error("Failed to load projects from localStorage", e);
            return [];
        }
    }
    saveAllProjects(projects) {
        const str = JSON.stringify(projects);
        try {
            window.ApexNativeBridge.setItem(this.STORAGE_KEY, str);
        } catch (e) {
            const isQuota = e instanceof DOMException && (e.code === 22 || e.name === 'QuotaExceededError');
            if (isQuota) {
                const kb = Math.round(str.length / 1024);
                alert(`Storage full (saving ${kb} KB). Delete some older projects to free space.`);
            } else {
                alert('Warning: Could not save project. Local Storage might be full.');
            }
            console.error('[Apex] saveAllProjects failed:', e);
        }
    }
    createNewProject() {
        const id = this.generateId();
        this.currentProjectId = id;
        this.nodes = [];
        this.pitNodes = [];
        this.isClosedTrack = false;
        this.selectedTrackTags = this.membershipAccess.tags.length === 1 ? [...this.membershipAccess.tags] : [];
        this.selectedRallyFormat = 'normal';
        this.bgImage = null;
        this.selectedIndices.clear();
        this.hasUnsavedChanges = false; // Start clean
        const nameInput = document.getElementById('project-name-input');
        nameInput.value = 'New Track';
        this.setTrackWidth(36, true);
        this.updateCloseCircuitAvailability();
        this.renderTrackTagSelector();
        this.renderSelectedTrackTags();
        this.hasUnsavedChanges = true;
        this.saveProject();
        // Update URL so refresh/deep-link works and bridge can identify project
        window.history.replaceState({}, '', `?id=${id}`);
        this.resize();
        this.draw();


    }
    loadProject(id) {
        const projects = this.getAllProjects();
        const proj = projects.find(p => p.id === id);
        if (!proj) return;
        this.loadProjectFromData(proj);
    }
    loadProjectFromData(proj) {
        if (!proj) return;
        this.currentProjectId = proj.id;
        const nameInput = document.getElementById('project-name-input');
        nameInput.value = proj.name;
        this.nodes = [];
        this.pitNodes = [];
        this.selectedIndices.clear();
        this.bgImage = null;
        this.isClosedTrack = !!proj.data.isClosedTrack;
        this.selectedTrackTags = this.normalizeTrackTags(proj.data.selectedTrackTags || []);
        this.selectedRallyFormat = proj.data.selectedRallyFormat || 'normal';
        if (this.selectedTrackTags.length === 0 && this.membershipAccess.tags.length === 1) {
            this.selectedTrackTags = [...this.membershipAccess.tags];
        }
        this.hasUnsavedChanges = false; // Reset on load
        this.syncTrackClosureFromSelection();
        this.updateCloseCircuitAvailability();
        if (proj.data.trackWidth !== undefined) {
            this.setTrackWidth(proj.data.trackWidth, true);
        } else {
            this.setTrackWidth(36, true);
        }
        if (proj.data.nodes && Array.isArray(proj.data.nodes)) {
            this.nodes = proj.data.nodes.map((n) => {
                const node = new TrackNode(n.x, n.y);
                node.sharpness = n.sharpness || 0;
                node.sector = n.sector || 1;
                node.isDRS = n.isDRS || false;
                node.type = n.type || 'straight';
                node.cpIn = n.cpIn ? { x: n.cpIn.x, y: n.cpIn.y } : null;
                node.cpOut = n.cpOut ? { x: n.cpOut.x, y: n.cpOut.y } : null;
                node.turnNumber = n.turnNumber || 0;
                node.elevation = n.elevation || 0;
                node.isElevationTransition = !!n.isElevationTransition;
                node.customWidth = (n.customWidth !== undefined && n.customWidth !== null) ? Math.max(MIN_TRACK_WIDTH, parseFloat(n.customWidth)) : null;
                node.isTransition = !!n.isTransition;
                return node;
            });
        }
        if (proj.data.pitNodes && Array.isArray(proj.data.pitNodes)) {
            this.pitNodes = proj.data.pitNodes.map((p) => ({ x: p.x, y: p.y }));
        }
        if (proj.data.scaleUnit) {
            this.scaleUnit = proj.data.scaleUnit;
            document.getElementById('scale-unit').value = this.scaleUnit;
        }
        if (proj.data.pxPerUnit) {
            this.pxPerUnit = proj.data.pxPerUnit;
            document.getElementById('px-unit').value = this.pxPerUnit.toString();
            document.getElementById('px-unit-val').innerText = `${Math.round(this.pxPerUnit)} px`;
        }
        if (proj.data.bgImage) {
            const img = new Image();
            img.onload = () => {
                this.bgImage = img;
                document.getElementById('ai-trace-btn').classList.remove('hidden');
                this.draw();
            };
            img.src = proj.data.bgImage;
        }
        if (proj.data.bgScale !== undefined) {
            this.bgScale = proj.data.bgScale;
            document.getElementById('bg-scale').value = (this.bgScale * 100).toString();
            document.getElementById('bg-scale-val').innerText = `${this.bgScale.toFixed(1)}x`;
        }
        if (proj.data.bgOpacity !== undefined) {
            this.bgOpacity = proj.data.bgOpacity;
            document.getElementById('bg-opacity').value = (this.bgOpacity * 100).toString();
            document.getElementById('bg-opacity-val').innerText = `${Math.round(this.bgOpacity * 100)}%`;
        }
        this.renderTrackTagSelector();
        this.renderSelectedTrackTags();
        this.updateUI();
        this.draw();
    }
    queueAutoSave() {
        this.hasUnsavedChanges = true; // Mark as dirty
        if (this.saveTimeout)
            window.clearTimeout(this.saveTimeout);
        this.saveTimeout = window.setTimeout(() => this.saveProject(), 1000);
        this.recordState();
    }
    saveProject() {
        if (!this.currentProjectId || !this.hasUnsavedChanges)
            return;
        const projects = this.getAllProjects();
        const existingIndex = projects.findIndex(p => p.id === this.currentProjectId);
        const name = document.getElementById('project-name-input').value || 'Untitled Circuit';
        let bgImageDataUrl = null;
        if (this.bgImage) {
            try {
                const MAX_DIM = 1200;
                let w = this.bgImage.width;
                let h = this.bgImage.height;
                let scaleAdjustment = 1.0;
                if (w > MAX_DIM || h > MAX_DIM) {
                    const ratio = Math.min(MAX_DIM / w, MAX_DIM / h);
                    w = Math.floor(w * ratio);
                    h = Math.floor(h * ratio);
                    scaleAdjustment = 1.0 / ratio;
                }
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = w;
                tempCanvas.height = h;
                const tCtx = tempCanvas.getContext('2d');
                tCtx.fillStyle = '#ffffff';
                tCtx.fillRect(0, 0, w, h);
                tCtx.drawImage(this.bgImage, 0, 0, w, h);
                bgImageDataUrl = tempCanvas.toDataURL('image/jpeg', 0.5);
                this.bgScale *= scaleAdjustment; // Adjust current scale
            }
            catch (e) { }
        }
        const projData = {
            nodes: this.nodes,
            pitNodes: this.pitNodes,
            isClosedTrack: this.isClosedTrack,
            selectedTrackTags: this.selectedTrackTags,
            selectedRallyFormat: this.selectedRallyFormat,
            trackWidth: this.trackWidth,
            scaleUnit: this.scaleUnit,
            pxPerUnit: this.pxPerUnit,
            bgImage: bgImageDataUrl,
            bgScale: this.bgScale,
            bgOpacity: this.bgOpacity
        };
        const projObject = {
            id: this.currentProjectId,
            name: name,
            lastModified: Date.now(),
            data: projData
        };
        if (existingIndex >= 0) {
            projects[existingIndex] = projObject;
        }
        else {
            projects.push(projObject);
        }
        this.saveAllProjects(projects);
        this.hasUnsavedChanges = false; // Reset after successful save
        this.showSaveStatus();
    }
    showSaveStatus() {
        const statusEl = document.getElementById('save-status');
        statusEl.classList.remove('opacity-0');
        setTimeout(() => statusEl.classList.add('opacity-0'), 2000);
    }
    renderProjectsList() {
        const container = document.getElementById('projects-list');
        const projects = this.getAllProjects().sort((a, b) => b.lastModified - a.lastModified);
        if (projects.length === 0) {
            container.innerHTML = `<div class="text-white/40 text-sm text-center py-8">No saved projects found.</div>`;
            return;
        }
        container.innerHTML = projects.map(p => {
            const date = new Date(p.lastModified).toLocaleString();
            const isCurrent = p.id === this.currentProjectId;
            const nodeCount = p.data.nodes ? p.data.nodes.length : 0;
            return `
                        <div class="bg-white/5 border ${isCurrent ? 'border-[#e10600]' : 'border-white/10'} rounded-lg p-4 flex items-center justify-between group hover:bg-white/10 transition">
                            <div class="flex-1 cursor-pointer" onclick="window.appInstance.loadProjectFromUI('${p.id}')">
                                <div class="flex items-center gap-2 mb-1">
                                    <h3 class="text-white font-bold f1-font tracking-widest uppercase">${p.name}</h3>
                                    ${isCurrent ? `<span class="bg-[#e10600]/20 text-[#e10600] text-[8px] uppercase px-1.5 py-0.5 rounded border border-[#e10600]/30 font-bold tracking-widest">Active</span>` : ''}
                                </div>
                                <div class="text-[10px] text-white/50 tracking-widest flex gap-3">
                                    <span>🕒 ${date}</span>
                                    <span>📍 ${nodeCount} Nodes</span>
                                </div>
                            </div>
                            <div class="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                ${!isCurrent ? `
                                <button onclick="window.appInstance.deleteProject('${p.id}')" class="p-2 text-white/30 hover:text-red-500 hover:bg-red-500/10 rounded transition" title="Delete Project">
                                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                                </button>
                                ` : ''}
                            </div>
                        </div>
                    `;
        }).join('');
    }
    loadProjectFromUI(id) {
        this.loadProject(id);
        document.getElementById('project-modal').classList.add('hidden');
    }
    deleteProject(id) {
        if (!confirm("Are you sure you want to delete this project?"))
            return;
        let projects = this.getAllProjects();
        projects = projects.filter(p => p.id !== id);
        this.saveAllProjects(projects);
        this.renderProjectsList();
    }
    updateAITrackSuggestion(distance, unit, numCorners) {
        let distKM = distance;
        if (unit === 'm')
            distKM = distance / 1000;
        if (unit === 'cm')
            distKM = distance / 100000;
        if (!this.hasPremiumAccess()) {
            const el = document.getElementById('selected-track-tags');
            if (el) {
                el.innerText = this.getImperfectAIDetectionLabel(distKM, numCorners);
            }
        } else {
            this.renderSelectedTrackTags();
        }
        this.updateAISuggestions(distKM, numCorners);
    }
    getImperfectAIDetectionLabel(distKM, numCorners) {
        if (distKM === 0 || this.nodes.length < 3) {
            return 'AI DETECTS: EVALUATING...';
        }
        const classes = ['KARTING CIRCUIT', 'CLUB CIRCUIT', 'F1 GRADE 1', 'LMP / WEC HYPERCAR'];
        let index = 0;
        if (distKM < 1.0)
            index = 0;
        else if (distKM <= 3.0)
            index = 1;
        else if (distKM <= 7.0)
            index = 2;
        else
            index = 3;
        // Free-mode detection is intentionally imperfect instead of always exact.
        const drift = (this.nodes.length + numCorners) % 4 === 0 ? 1 : ((this.nodes.length + numCorners) % 7 === 0 ? -1 : 0);
        const finalIndex = Math.max(0, Math.min(classes.length - 1, index + drift));
        return `AI DETECTS: ${classes[finalIndex]}`;
    }
    updateAISuggestions(distKM, numCorners) {
        const listEl = document.getElementById('ai-suggestions-list');
        const suggestions = [];
        const totalNodes = this.nodes.length;
        const len = totalNodes;
        const drsCount = this.nodes.filter(n => n.isDRS).length;
        let hairpins = 0;
        let sweepers = 0;
        let straights = 0;
        
        for (let i = 0; i < len; i++) {
            const p1 = this.nodes[i];
            const p2 = this.nodes[(i + 1) % len];
            const pPrev = this.nodes[(i - 1 + len) % len];
            
            let angleDeg = 0;
            if (pPrev && p2) {
                const dx1 = p1.x - pPrev.x;
                const dy1 = p1.y - pPrev.y;
                const dx2 = p2.x - p1.x;
                const dy2 = p2.y - p1.y;
                
                const dot = dx1 * dx2 + dy1 * dy2;
                const mag1 = Math.hypot(dx1, dy1);
                const mag2 = Math.hypot(dx2, dy2);
                if (mag1 > 0 && mag2 > 0) {
                    const cosA = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
                    angleDeg = Math.acos(cosA) * (180 / Math.PI);
                }
            }
            
            if (angleDeg > 135) hairpins++;
            else if (angleDeg > 15 && angleDeg <= 45) sweepers++;
            else if (angleDeg <= 15) straights++;
        }
        // --- Track Completeness ---
        if (!this.isClosedTrack) {
            suggestions.push({ icon: '⚠️', color: 'yellow', title: 'OPEN CIRCUIT', text: 'Your track is not closed. Press "Auto-Close Circuit" to connect the last point to the first.' });
        }
        if (totalNodes < 8) {
            suggestions.push({ icon: '📍', color: 'blue', title: 'ADD MORE POINTS', text: `Only ${totalNodes} points detected. A well-designed track typically needs 20+ nodes for smooth, realistic curves.` });
        }
        // --- Length Recommendations ---
        if (distKM > 0 && distKM < 2.5) {
            suggestions.push({ icon: '📏', color: 'orange', title: 'SHORT TRACK', text: `At ${distKM.toFixed(2)} km this is very short. F1 Grade 1 circuits require a minimum of 3.5 km. Consider scaling up.` });
        }
        else if (distKM >= 3.5 && distKM <= 7.0) {
            suggestions.push({ icon: '✅', color: 'green', title: 'IDEAL F1 LENGTH', text: `${distKM.toFixed(2)} km is within FIA F1 Grade 1 specification (3.5–7.0 km). Great length!` });
        }
        else if (distKM > 7.0) {
            suggestions.push({ icon: '🏁', color: 'purple', title: 'ENDURANCE LENGTH', text: `${distKM.toFixed(2)} km qualifies as an endurance circuit. Suitable for LMP/WEC but too long for standard F1.` });
        }
        // --- Corner Balance ---
        if (numCorners > 0) {
            const cornerRatio = numCorners / Math.max(totalNodes, 1);
            if (cornerRatio > 0.85) {
                suggestions.push({ icon: '🌀', color: 'orange', title: 'TOO MANY CORNERS', text: 'Over 85% of your nodes are corners. Consider adding longer straights to give drivers breathing room and enable overtaking.' });
            }
            else if (hairpins > 4) {
                suggestions.push({ icon: '↩️', color: 'yellow', title: 'EXCESS HAIRPINS', text: `${hairpins} hairpin corners detected. Multiple consecutive hairpins create street circuit-like layouts. Consider variety.` });
            }
            else if (sweepers > 5) {
                suggestions.push({ icon: '🏎️', color: 'green', title: 'HIGH SPEED DESIGN', text: `${sweepers} sweeping corners create a high-speed, driver-demanding layout similar to Silverstone or Spa.` });
            }
        }
        // --- DRS Suggestions ---
        if (distKM >= 3.5 && drsCount === 0) {
            suggestions.push({ icon: '💨', color: 'green', title: 'ADD DRS ZONES', text: 'FIA regulations typically mandate 2–3 DRS detection/activation zones. Use the DRS tool to mark suitable long straights.' });
        }
        else if (drsCount > 3) {
            suggestions.push({ icon: '⚡', color: 'yellow', title: 'TOO MANY DRS ZONES', text: `${drsCount} DRS zones detected. Most circuits have 2–3. Too many zones reduce overtaking quality.` });
        }
        else if (drsCount >= 1 && drsCount <= 3) {
            suggestions.push({ icon: '✅', color: 'green', title: 'DRS CONFIGURED', text: `${drsCount} DRS zone(s) configured — within FIA standard for modern F1 circuits.` });
        }
        // --- Straight Proportion ---
        if (straights > 0 && totalNodes > 5) {
            const straightRatio = straights / totalNodes;
            if (straightRatio < 0.15) {
                suggestions.push({ icon: '➡️', color: 'blue', title: 'MORE STRAIGHTS NEEDED', text: 'Very few straight sections. Add straights for overtaking opportunities and to allow cars to reach top speed.' });
            }
        }
        // --- Positivity fallback ---
        if (suggestions.length === 0) {
            suggestions.push({ icon: '🏆', color: 'green', title: 'GREAT DESIGN!', text: 'Your track looks well-balanced. Corner variety, length, and DRS configuration all look solid.' });
        }
        // Render
        const colorMap = {
            green: 'border-green-500/30 bg-green-500/5 text-green-300',
            yellow: 'border-yellow-500/30 bg-yellow-500/5 text-yellow-300',
            orange: 'border-orange-500/30 bg-orange-500/5 text-orange-300',
            blue: 'border-blue-500/30 bg-blue-500/5 text-blue-300',
            purple: 'border-purple-500/30 bg-purple-500/5 text-purple-300',
            red: 'border-red-500/30 bg-red-500/5 text-red-300'
        };
        listEl.innerHTML = suggestions.map(s => `
                    <div class="rounded border ${colorMap[s.color] || colorMap['blue']} p-2.5">
                        <div class="font-bold text-[10px] tracking-widest mb-0.5">${s.icon} ${s.title}</div>
                        <div class="text-[9px] text-white/50 leading-relaxed">${s.text}</div>
                    </div>
                `).join('');
    }
    getHistorySnapshot() {
        return {
            nodes: this.nodes.map(n => ({
                x: n.x,
                y: n.y,
                sharpness: n.sharpness,
                sector: n.sector,
                isDRS: n.isDRS,
                type: n.type,
                elevation: n.elevation || 0,
                isElevationTransition: !!n.isElevationTransition,
                cpIn: n.cpIn ? { x: n.cpIn.x, y: n.cpIn.y } : null,
                cpOut: n.cpOut ? { x: n.cpOut.x, y: n.cpOut.y } : null,
                turnNumber: n.turnNumber || 0
            })),
            pitNodes: this.pitNodes.map(p => ({ x: p.x, y: p.y })),
            isClosedTrack: this.isClosedTrack,
            selectedTrackTags: [...this.selectedTrackTags],
            selectedRallyFormat: this.selectedRallyFormat,
            scaleUnit: this.scaleUnit,
            pxPerUnit: this.pxPerUnit
        };
    }
    applyHistorySnapshot(snapshot) {
        this.isClosedTrack = !!snapshot.isClosedTrack;
        this.selectedTrackTags = this.normalizeTrackTags(snapshot.selectedTrackTags || []);
        this.selectedRallyFormat = snapshot.selectedRallyFormat || 'normal';
        this.nodes = snapshot.nodes.map(n => {
            const node = new TrackNode(n.x, n.y);
            node.sharpness = n.sharpness || 0;
            node.sector = n.sector || 1;
            node.isDRS = n.isDRS || false;
            node.type = n.type || 'straight';
            node.elevation = n.elevation || 0;
            node.isElevationTransition = !!n.isElevationTransition;
            node.cpIn = n.cpIn ? { x: n.cpIn.x, y: n.cpIn.y } : null;
            node.cpOut = n.cpOut ? { x: n.cpOut.x, y: n.cpOut.y } : null;
            node.turnNumber = n.turnNumber || 0;
            return node;
        });
        this.pitNodes = snapshot.pitNodes.map(p => ({ x: p.x, y: p.y }));
        this.scaleUnit = snapshot.scaleUnit;
        this.pxPerUnit = snapshot.pxPerUnit;

        // Update UI elements to match the snapshot state
        this.syncTrackClosureFromSelection();
        this.updateCloseCircuitAvailability();
        const scaleUnitEl = document.getElementById('scale-unit');
        if (scaleUnitEl) scaleUnitEl.value = this.scaleUnit;
        const pxUnitEl = document.getElementById('px-unit');
        if (pxUnitEl) {
            pxUnitEl.value = this.pxPerUnit.toString();
            const pxValEl = document.getElementById('px-unit-val');
            if (pxValEl) pxValEl.innerText = `${Math.round(this.pxPerUnit)} px`;
        }
        this.renderTrackTagSelector();
        this.renderSelectedTrackTags();

        this.selectedIndices.clear();
        this.draw();
    }
    recordState() {
        if (this.isApplyingHistory) return;
        
        const snapshot = this.getHistorySnapshot();
        
        // Discard any redo states if we are recording a new action
        if (this.historyIndex < this.history.length - 1) {
            this.history = this.history.slice(0, this.historyIndex + 1);
        }
        
        // Check if snapshot is identical to last stored to avoid duplicates
        if (this.history.length > 0) {
            const lastSnapshot = this.history[this.history.length - 1];
            if (JSON.stringify(lastSnapshot) === JSON.stringify(snapshot)) {
                return;
            }
        }
        
        this.history.push(snapshot);
        // Cap history to prevent unbounded memory growth
        const MAX_HISTORY = 50;
        if (this.history.length > MAX_HISTORY) {
            this.history = this.history.slice(this.history.length - MAX_HISTORY);
        }
        this.historyIndex = this.history.length - 1;
        this.updateUndoRedoButtons();
    }
    undo() {
        if (this.historyIndex > 0) {
            this.historyIndex--;
            this.isApplyingHistory = true;
            this.applyHistorySnapshot(this.history[this.historyIndex]);
            this.queueAutoSave();
            this.isApplyingHistory = false;
            this.updateUndoRedoButtons();
        }
    }
    redo() {
        if (this.historyIndex < this.history.length - 1) {
            this.historyIndex++;
            this.isApplyingHistory = true;
            this.applyHistorySnapshot(this.history[this.historyIndex]);
            this.queueAutoSave();
            this.isApplyingHistory = false;
            this.updateUndoRedoButtons();
        }
    }
    updateUndoRedoButtons() {
        const undoBtn = document.getElementById('undo-btn');
        const redoBtn = document.getElementById('redo-btn');
        if (undoBtn) {
            if (this.historyIndex > 0) {
                undoBtn.removeAttribute('disabled');
                undoBtn.classList.remove('opacity-30', 'cursor-not-allowed');
            } else {
                undoBtn.setAttribute('disabled', 'true');
                undoBtn.classList.add('opacity-30', 'cursor-not-allowed');
            }
        }
        if (redoBtn) {
            if (this.historyIndex < this.history.length - 1) {
                redoBtn.removeAttribute('disabled');
                redoBtn.classList.remove('opacity-30', 'cursor-not-allowed');
            } else {
                redoBtn.setAttribute('disabled', 'true');
                redoBtn.classList.add('opacity-30', 'cursor-not-allowed');
            }
        }
    }
}
window.addEventListener('load', () => {
    window.appInstance = new App();
});
