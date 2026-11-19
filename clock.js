/**
 * Horloges de la partie (blancs / noirs).
 * Modes : 'inf' (pas d'horloge), 'fixed' (temps fixe par coup pour le moteur),
 *         'normal' (temps total + ajout par coup), 'tourn' (X minutes pour N coups, répété).
 */
export class GameClock extends EventTarget {
    constructor() {
        super();
        this.cfg = { mode: 'inf', min: 5, sec: 0, inc: 0, n: 30, pm: 3 };
        this._timer = null;
        this.reset();
    }
    get active() { return this.cfg.mode === 'normal' || this.cfg.mode === 'tourn'; }
    setConfig(cfg) { this.cfg = { ...this.cfg, ...cfg }; this.reset(); }
    _initialMs() { return Math.max(1, this.cfg.min) * 60000; }
    reset() {
        const t = this.active ? this._initialMs() : 0;
        this.ms = { white: t, black: t };
        this.moves = { white: 0, black: 0 };
        this.running = null; this.paused = null; this.flag = null;
        this._last = 0;
        this._stopTimer();
        this._emit();
    }
    _stopTimer() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
    _settle() {
        if (!this.running) return;
        const now = performance.now();
        this.ms[this.running] -= now - this._last;
        this._last = now;
    }
    start(side) {
        if (!this.active || this.flag) return;
        this._settle();
        this.running = side; this.paused = null;
        this._last = performance.now();
        if (!this._timer) this._timer = setInterval(() => this._tick(), 100);
        this._emit();
    }
    stop() {
        this._settle();
        this.running = null;
        this._stopTimer();
        this._emit();
    }
    pause() { if (this.running) { this.paused = this.running; this.stop(); } }
    resume() { if (this.paused) this.start(this.paused); }
    moveMade(side) {
        if (!this.active) return;
        this._settle();
        this.moves[side]++;
        if (this.cfg.mode === 'normal') this.ms[side] += (this.cfg.inc || 0) * 1000;
        else if (this.cfg.mode === 'tourn' && this.moves[side] % this.cfg.n === 0) this.ms[side] += this._initialMs();
    }
    remainingMs(side) {
        let v = this.ms[side];
        if (this.running === side) v -= performance.now() - this._last;
        return v;
    }
    movesToGo(side) {
        if (this.cfg.mode === 'tourn') return Math.max(1, this.cfg.n - (this.moves[side] % this.cfg.n));
        return 30;
    }
    _tick() {
        if (!this.running) return;
        this._settle();
        if (this.ms[this.running] <= 0) {
            const side = this.running;
            this.ms[side] = 0;
            this.flag = side;
            this.running = null; this._stopTimer();
            this._emit();
            this.dispatchEvent(new CustomEvent('flag', { detail: { side } }));
            return;
        }
        this._emit();
    }
    _emit() { this.dispatchEvent(new CustomEvent('tick')); }
}

export function fmtClock(ms) {
    if (ms < 0) ms = 0;
    if (ms < 10000) return `0:0${(ms / 1000).toFixed(1)}`.replace(/^0:0(\d)\.(\d)$/, '0:0$1.$2');
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
