document.addEventListener("DOMContentLoaded", async function () {

    /* ===================== CONFIG ===================== */

    // Placeholders are swapped for real values by the GitHub Actions workflow at deploy time.
    const firebaseConfig = {
        apiKey: "__FIREBASE_API_KEY__",
        authDomain: "__FIREBASE_AUTH_DOMAIN__",
        databaseURL: "__FIREBASE_DATABASE_URL__",
        projectId: "__FIREBASE_PROJECT_ID__",
        appId: "__FIREBASE_APP_ID__"
    };

    const WORK_DURATION = 25 * 60; // seconds - one focus session
    const REST_DURATION = 5 * 60;  // seconds - rest that starts right after every focus session
    const MAX_SESSIONS = 8;        // upper limit for the consecutive-sessions stepper
    const MAX_TASK_LINES = 3;      // a task box grows up to this many lines, then scrolls / shows a hover tooltip
    const MAX_TASK_LENGTH = 500;   // characters

    // Database paths (shared by everyone who opens the page)
    const STATE_PATH = "pomodoroState";
    const TASKS_PATH_Y = "pomodoroTasksY";
    const TASKS_PATH_R = "pomodoroTasksR";
    const SUMMARY_PATH = "pomodoroSummary";


    /* ===================== STORAGE LAYER ===================== */
    // One small interface (subscribe / set / update / remove / transaction) with two
    // implementations: Firebase (shared between users) and a localStorage-backed fallback
    // used when Firebase isn't configured, e.g. when testing on localhost.

    function createFirebaseStore() {
        firebase.initializeApp(firebaseConfig);
        const db = firebase.database();
        const safe = (promise) => promise.catch((err) => console.error("Database write failed:", err));
        return {
            mode: "firebase",
            subscribe: (path, cb) => db.ref(path).on("value", (snap) => cb(snap.val())),
            set: (path, value) => safe(db.ref(path).set(value)),
            update: (path, obj) => safe(db.ref(path).update(obj)),
            remove: (path) => safe(db.ref(path).remove()),
            transaction: (path, fn) =>
                db.ref(path).transaction(fn).then((r) => ({ committed: r.committed })).catch((err) => {
                    console.error("Database transaction failed:", err);
                    return { committed: false };
                }),
            onServerOffset: (cb) => db.ref(".info/serverTimeOffset").on("value", (snap) => cb(snap.val() || 0))
        };
    }

    function createLocalStore() {
        const KEY = "pomodoroLocalDB";
        const listeners = [];
        let root = {};
        try { root = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { root = {}; }

        const keysOf = (path) => path.split("/").filter(Boolean);
        const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

        function getIn(path) {
            let node = root;
            for (const k of keysOf(path)) {
                if (node === null || typeof node !== "object") return null;
                node = node[k];
            }
            return node === undefined ? null : node;
        }

        function setIn(path, value) {
            const keys = keysOf(path);
            let node = root;
            for (let i = 0; i < keys.length - 1; i++) {
                if (node[keys[i]] === null || typeof node[keys[i]] !== "object" || node[keys[i]] === undefined) {
                    node[keys[i]] = {};
                }
                node = node[keys[i]];
            }
            const last = keys[keys.length - 1];
            if (value === null || value === undefined) delete node[last];
            else node[last] = clone(value);
        }

        function refresh() {
            try { root = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { root = {}; }
        }

        function notifyAll() {
            listeners.forEach((l) => l.cb(clone(getIn(l.path))));
        }

        function persistAndNotify() {
            try { localStorage.setItem(KEY, JSON.stringify(root)); } catch { /* storage full / blocked */ }
            notifyAll();
        }

        // Other tabs of the same browser act as "other users" when testing locally
        window.addEventListener("storage", (e) => {
            if (e.key !== KEY) return;
            try { root = JSON.parse(e.newValue) || {}; } catch { root = {}; }
            notifyAll();
        });

        return {
            mode: "local",
            subscribe(path, cb) {
                listeners.push({ path, cb });
                setTimeout(() => cb(clone(getIn(path))), 0);
            },
            set(path, value) { refresh(); setIn(path, value); persistAndNotify(); return Promise.resolve(); },
            update(path, obj) {
                refresh();
                Object.keys(obj).forEach((k) => setIn(path + "/" + k, obj[k]));
                persistAndNotify();
                return Promise.resolve();
            },
            remove(path) { refresh(); setIn(path, null); persistAndNotify(); return Promise.resolve(); },
            transaction(path, fn) {
                refresh();
                const next = fn(clone(getIn(path)));
                if (next === undefined) return Promise.resolve({ committed: false });
                setIn(path, next);
                persistAndNotify();
                return Promise.resolve({ committed: true });
            },
            onServerOffset(cb) { cb(0); }
        };
    }

    const firebaseConfigured =
        typeof firebase !== "undefined" &&
        Object.values(firebaseConfig).every((v) => v && !v.startsWith("__"));

    let store = null;
    if (firebaseConfigured) {
        try {
            store = createFirebaseStore();
        } catch (err) {
            console.error("Firebase failed to initialize:", err);
        }
    }
    if (!store) {
        console.warn("Firebase not configured - running in local-only mode (data is shared between tabs of this browser only).");
        store = createLocalStore();
    }

    // Login gate (pomodoro-notes.js): nothing below runs - no database listeners, no timer -
    // until one of the two allowed accounts has signed in.
    const session = await window.PomodoroAuth.require(store);

    // Use the database server's clock so users with slightly-off computer clocks stay in sync
    let serverOffset = 0;
    store.onServerOffset((offset) => { serverOffset = offset; });
    const now = () => Date.now() + serverOffset;

    // Week identifier, e.g. "2026-W40" (weeks start on Monday, in the viewer's local time)
    function weekKeyFor(dateMs) {
        const d = new Date(dateMs);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
        const week1 = new Date(d.getFullYear(), 0, 4);
        const week = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
        return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
    }
    function weekKey() { return weekKeyFor(now()); }


    /* ===================== SYNCED TIMER ===================== */

    /* ===================== BELL SOUND ===================== */
    // Synthesized with the Web Audio API - no sound file to host or fetch.
    // Browsers block audio until the visitor has interacted with the page at least
    // once, so the AudioContext is created/unlocked on the first Play click.

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    let audioCtx = null;

    function unlockAudio() {
        if (!AudioContextClass) return;
        if (!audioCtx) audioCtx = new AudioContextClass();
        if (audioCtx.state === "suspended") audioCtx.resume();
    }

    // Any interaction anywhere on the page unlocks audio, not just pressing Play -
    // the person who opens this page may never touch the timer buttons themselves.
    document.addEventListener("pointerdown", unlockAudio, { once: true });
    document.addEventListener("keydown", unlockAudio, { once: true });

    // kind "normal": the usual two-note ding (work or rest finished).
    // kind "final":  a longer rising four-note chime meaning the whole run of consecutive sessions is over.
    const BELL_NOTES = {
        normal: { freqs: [880, 1320],            spacing: 0.15, tail: 1.2 },
        final:  { freqs: [523, 659, 784, 1047],  spacing: 0.22, tail: 1.8 }
    };

    function playBell(kind = "normal") {
        if (!audioCtx) return;
        try {
            const { freqs, spacing, tail } = BELL_NOTES[kind] || BELL_NOTES.normal;
            const t0 = audioCtx.currentTime;
            freqs.forEach((freq, i) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = kind === "final" ? "triangle" : "sine";
                osc.frequency.value = freq;
                const start = t0 + i * spacing;
                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + tail);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(start);
                osc.stop(start + tail + 0.1);
            });
        } catch (err) {
            console.error("Could not play the bell sound:", err);
        }
    }


    /* ===================== SYNCED TIMER ===================== */

    const timerBox = document.getElementById("timerBox");
    const timerDisplay = document.getElementById("timerDisplay");
    const timerPhaseEl = document.getElementById("timerPhase");
    const timerSubEl = document.getElementById("timerSub");
    const toggleBtn = document.getElementById("toggleBtn");
    const resetBtn = document.getElementById("resetBtn");
    const sessionsMinus = document.getElementById("sessionsMinus");
    const sessionsPlus = document.getElementById("sessionsPlus");
    const sessionsCountEl = document.getElementById("sessionsCount");
    const sessionTotalEl = document.getElementById("sessionTotal");

    // pomodoroState in the database:
    //   running       - is the countdown ticking?
    //   endTime       - (server ms) when the current phase ends; only meaningful while running
    //   remaining     - seconds left in the current phase while paused / idle
    //   phase         - "work" | "rest"
    //   sessionIndex  - which focus session of the run we are in (1-based)
    //   totalSessions - how many consecutive sessions were configured (1 = a single session)
    //   lastEvent     - { at, kind } written whenever a phase finishes naturally;
    //                   kind "normal" = regular ding, "final" = whole run is over. Every open page
    //                   plays the matching sound when it sees a new lastEvent.
    // Older records without phase / sessionIndex / totalSessions are treated as a single work session.
    const durationFor = (phase) => (phase === "rest" ? REST_DURATION : WORK_DURATION);

    function normalizeState(data) {
        const total = Math.min(MAX_SESSIONS, Math.max(1, Math.round(Number(data.totalSessions)) || 1));
        const phase = data.phase === "rest" ? "rest" : "work";
        const state = {
            running: !!data.running,
            endTime: data.endTime || null,
            remaining: data.remaining ?? durationFor(phase),
            phase,
            sessionIndex: Math.min(total, Math.max(1, Math.round(Number(data.sessionIndex)) || 1)),
            totalSessions: total,
            lastEvent: null
        };
        if (data.lastEvent && typeof data.lastEvent.at === "number") state.lastEvent = data.lastEvent;
        return state;
    }

    // A fresh, not-started run: session 1, work phase, full time on the clock
    function idleState(totalSessions, lastEvent) {
        const state = {
            running: false, endTime: null, remaining: WORK_DURATION,
            phase: "work", sessionIndex: 1, totalSessions: totalSessions || 1
        };
        if (lastEvent) state.lastEvent = lastEvent;
        return state;
    }

    // The current state with some fields changed (never contains undefined - Firebase rejects it)
    function stateWith(changes) {
        return Object.assign({
            running: remoteState.running,
            endTime: remoteState.endTime,
            remaining: remoteState.remaining,
            phase: remoteState.phase,
            sessionIndex: remoteState.sessionIndex,
            totalSessions: remoteState.totalSessions
        }, changes);
    }

    // The state to move to when the running phase hits zero:
    //   work -> rest (auto-starts)
    //   rest -> next work session (auto-starts), or back to idle when it was the last one
    // The final rest of a multi-session run uses the "final" ding; everything else is "normal".
    function stateAfterCompletion(current) {
        const s = normalizeState(current);
        // Chain phases off the previous end time so there's no drift; if the page was closed
        // for a while (stale), start the next phase from now instead of replaying the backlog.
        const anchor = now() - s.endTime < 3000 ? s.endTime : now();

        if (s.phase === "work") {
            return {
                running: true, endTime: anchor + REST_DURATION * 1000, remaining: REST_DURATION,
                phase: "rest", sessionIndex: s.sessionIndex, totalSessions: s.totalSessions,
                lastEvent: { at: now(), kind: "normal" }
            };
        }
        if (s.sessionIndex < s.totalSessions) {
            return {
                running: true, endTime: anchor + WORK_DURATION * 1000, remaining: WORK_DURATION,
                phase: "work", sessionIndex: s.sessionIndex + 1, totalSessions: s.totalSessions,
                lastEvent: { at: now(), kind: "normal" }
            };
        }
        return idleState(s.totalSessions, { at: now(), kind: s.totalSessions > 1 ? "final" : "normal" });
    }

    let remoteState = idleState(1);
    let finishing = false;      // true while a "phase hit zero" transaction is in flight
    let eventsPrimed = false;   // the first snapshot only records the latest event; it never rings
    let seenEventAt = null;

    function formatTime(totalSeconds) {
        const s = Math.max(0, Math.round(totalSeconds));
        const mm = Math.floor(s / 60).toString().padStart(2, "0");
        const ss = (s % 60).toString().padStart(2, "0");
        return `${mm}:${ss}`;
    }

    function secondsLeft() {
        if (remoteState.running && remoteState.endTime) {
            return Math.max(0, (remoteState.endTime - now()) / 1000);
        }
        return remoteState.remaining ?? durationFor(remoteState.phase);
    }

    function renderTimer() {
        const left = secondsLeft();
        timerDisplay.textContent = formatTime(left);

        const runningKey = remoteState.running ? "running" : "paused";
        if (toggleBtn.dataset.state !== runningKey) {
            toggleBtn.dataset.state = runningKey;
            toggleBtn.innerHTML = remoteState.running
                ? '<i class="fas fa-pause"></i> Pause'
                : '<i class="fas fa-play"></i> Play';
        }

        if (remoteState.running && left <= 0 && !finishing) {
            finishing = true;
            const finishedPhase = remoteState.phase;
            // Every open page notices the phase hit zero, but the transaction only commits for the
            // first one - so the focused time is counted once, not once per user.
            store.transaction(STATE_PATH, (current) => {
                if (current === null) return current;
                if (current.running && current.endTime && current.endTime <= now()) {
                    return stateAfterCompletion(current);
                }
                return undefined; // someone else already handled it
            }).then((result) => {
                // Only focus sessions count toward "Time Focused", not rests
                if (result.committed && finishedPhase === "work") addFocusedMinutes(WORK_DURATION / 60);
            });
        }
    }

    // Labels, rest colour theme, and the sessions stepper - redrawn whenever the shared state changes
    function renderPhase() {
        const s = remoteState;
        const resting = s.phase === "rest";
        timerBox.classList.toggle("resting", resting);
        timerPhaseEl.textContent = resting ? "Rest" : "Focus";

        if (resting) {
            timerSubEl.textContent = s.totalSessions > 1
                ? `Session ${s.sessionIndex} of ${s.totalSessions} done`
                : "Time to rest";
        } else {
            timerSubEl.textContent = s.totalSessions > 1 ? `Session ${s.sessionIndex} of ${s.totalSessions}` : "";
        }

        sessionsCountEl.textContent = s.totalSessions;
        const totalMin = s.totalSessions * (WORK_DURATION + REST_DURATION) / 60;
        const label = totalMin >= 60 ? `${Math.floor(totalMin / 60)}h ${totalMin % 60}m` : `${totalMin}m`;
        sessionTotalEl.textContent = `${s.totalSessions} × (25 + 5) = ${label}`;

        // The count can only be changed on a fresh, not-started run (Reset to change it mid-run)
        const editable = !s.running && s.phase === "work" && s.sessionIndex === 1 && s.remaining >= WORK_DURATION;
        sessionsMinus.disabled = !editable || s.totalSessions <= 1;
        sessionsPlus.disabled = !editable || s.totalSessions >= MAX_SESSIONS;
    }

    store.subscribe(STATE_PATH, (data) => {
        if (!data) {
            store.set(STATE_PATH, idleState(1));
            return;
        }
        remoteState = normalizeState(data);
        finishing = false;
        renderPhase();

        // Every open page rings its own bell for a naturally-finished phase (not for pause / reset,
        // which never write a lastEvent). The first snapshot only records the latest event so
        // reloading the page never replays an old ding.
        const ev = remoteState.lastEvent;
        if (!eventsPrimed) {
            eventsPrimed = true;
            seenEventAt = ev ? ev.at : null;
        } else if (ev && ev.at !== seenEventAt) {
            seenEventAt = ev.at;
            if (now() - ev.at < 15000) playBell(ev.kind); // skip very stale events (e.g. tab was asleep)
        }
        renderTimer();
    });

    setInterval(renderTimer, 250);

    toggleBtn.addEventListener("click", () => {
        unlockAudio();
        if (remoteState.running) {
            store.set(STATE_PATH, stateWith({ running: false, endTime: null, remaining: secondsLeft() }));
        } else {
            const left = remoteState.remaining || 0;
            const remaining = left > 0 ? left : durationFor(remoteState.phase);
            store.set(STATE_PATH, stateWith({ running: true, endTime: now() + remaining * 1000, remaining }));
        }
    });

    // Reset always goes back to the start of the run (session 1, focus) and keeps the configured count
    resetBtn.addEventListener("click", () => {
        store.set(STATE_PATH, idleState(remoteState.totalSessions));
    });

    function changeSessions(delta) {
        const next = Math.min(MAX_SESSIONS, Math.max(1, remoteState.totalSessions + delta));
        if (next !== remoteState.totalSessions) store.update(STATE_PATH, { totalSessions: next });
    }
    sessionsMinus.addEventListener("click", () => changeSessions(-1));
    sessionsPlus.addEventListener("click", () => changeSessions(1));


        /* ===================== SYNCED CHECKLISTS ===================== */

    const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    // Grow a task's text box to fit its content, up to MAX_TASK_LINES; beyond that it
    // scrolls and the full text is available as a hover tooltip. Shared by both checklists.
    function autosize(el) {
        if (!el.isConnected) return;
        const cs = getComputedStyle(el);
        const lineHeight = parseFloat(cs.lineHeight) || 20;
        const padding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
        const maxHeight = lineHeight * MAX_TASK_LINES + padding;

        el.style.height = "auto";
        const fullHeight = el.scrollHeight;
        const clamped = fullHeight > maxHeight + 1;
        el.style.height = Math.min(fullHeight, maxHeight) + "px";
        el.style.overflowY = clamped ? "auto" : "hidden";
        if (clamped) el.title = el.value; else el.removeAttribute("title");
    }

    /* ---------- priority popover (shared by every band / entry button) ---------- */
    // One floating menu on <body>: position:fixed so the scrolling task list can't clip it.
    const PRIORITIES = ["high", "medium", "low"];   // anything else (or missing) = unmarked / grey
    const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
    const PRIORITY_LABEL = { high: "High", medium: "Medium", low: "Low", none: "None" };

    const priorityMenu = document.createElement("div");
    priorityMenu.className = "priority-menu";
    ["high", "medium", "low", "none"].forEach((key) => {
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "priority-option";
        opt.dataset.value = key;
        opt.innerHTML = `<span class="priority-swatch" data-priority="${key}"></span><span>${PRIORITY_LABEL[key]}</span>`;
        opt.addEventListener("click", () => {
            const pick = priorityMenuState && priorityMenuState.onPick;
            closePriorityMenu();
            if (pick) pick(key === "none" ? null : key);
        });
        priorityMenu.appendChild(opt);
    });
    document.body.appendChild(priorityMenu);

    let priorityMenuState = null;   // { anchor, onPick } while the menu is open

    function closePriorityMenu() {
        priorityMenu.classList.remove("open");
        priorityMenuState = null;
    }

    function openPriorityMenu(anchor, current, onPick) {
        if (priorityMenuState && priorityMenuState.anchor === anchor) { closePriorityMenu(); return; } // click again = close
        priorityMenuState = { anchor, onPick };
        priorityMenu.querySelectorAll(".priority-option").forEach((o) =>
            o.classList.toggle("selected", o.dataset.value === (current || "none")));
        priorityMenu.classList.add("open");

        // Right-align under the band; flip above it if there isn't room below
        const r = anchor.getBoundingClientRect();
        const w = priorityMenu.offsetWidth, h = priorityMenu.offsetHeight;
        const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
        let top = r.bottom + 4;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
        priorityMenu.style.left = left + "px";
        priorityMenu.style.top = top + "px";
    }

    document.addEventListener("pointerdown", (e) => {
        if (!priorityMenuState) return;
        if (priorityMenu.contains(e.target) || priorityMenuState.anchor.contains(e.target)) return;
        closePriorityMenu();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closePriorityMenu(); });
    window.addEventListener("resize", closePriorityMenu);
    window.addEventListener("scroll", closePriorityMenu, true);   // capture: also fires for the scrolling task list

    // One independent checklist: its own database path, its own input/list elements,
    // its own in-memory task array. Completions from either checklist still feed the
    // one shared weekly summary below.
    function createChecklist(tasksPath, inputId, listId, person) {
    // Defensive: if the call site forgot the 4th arg, derive from path.
        if (person !== "me" && person !== "gf") {
            person = (tasksPath === TASKS_PATH_R) ? "gf" : "me";
            console.warn(`[checklist] defaulting person="${person}" for ${inputId}`);
        }
        const taskInput = document.getElementById(inputId);
        const taskList = document.getElementById(listId);
        taskInput.maxLength = MAX_TASK_LENGTH;

        const box = taskInput.closest(".checklist-box");
        const sortBtn = box.querySelector(".sort-btn");
        const sortMenu = box.querySelector(".sort-menu");
        const entryPriorityBtn = box.querySelector(".entry-priority-btn");

        let tasks = [];                 // array built from the database (always oldest-first)
        const taskEls = new Map();      // task id -> its DOM element
        let entryPriority = null;       // priority picked for the task being typed

        // Sort choice is a personal view setting, so it's kept in this browser, not in the database
        const SORT_KEY = `pomodoroSort:${tasksPath}`;
        let sortMode = "date";
        try { if (localStorage.getItem(SORT_KEY) === "priority") sortMode = "priority"; } catch { /* storage blocked */ }

        const rankOf = (t) => (t.priority in PRIORITY_RANK ? PRIORITY_RANK[t.priority] : 3);

        // The order tasks are shown in: by date (oldest first) or high -> medium -> low -> unmarked, then date
        function sortedTasks() {
            const list = tasks.slice();
            if (sortMode === "priority") {
                list.sort((a, b) => rankOf(a) - rankOf(b) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
            }
            return list;
        }

        const taskPath = (id) => `${tasksPath}/${id}`;

        function autosizeAll() {
            taskEls.forEach((el) => autosize(el.querySelector(".task-text")));
        }

        function buildTaskEl(id) {
            const item = document.createElement("div");
            item.className = "task-item";

            const checkBtn = document.createElement("button");
            checkBtn.className = "task-check-btn";
            checkBtn.innerHTML = '<i class="fas fa-check"></i>';
            checkBtn.setAttribute("aria-label", "Mark task complete");
            checkBtn.addEventListener("click", () => toggleTask(id));

            const cancelBtn = document.createElement("button");
            cancelBtn.className = "task-cancel-btn";
            cancelBtn.innerHTML = '<i class="fas fa-xmark"></i>';
            cancelBtn.setAttribute("aria-label", "Remove task");
            cancelBtn.addEventListener("click", () => removeTask(id));

            const text = document.createElement("textarea");
            text.className = "task-text";
            text.rows = 1;
            text.maxLength = MAX_TASK_LENGTH;
            text.setAttribute("aria-label", "Task");
            text.addEventListener("input", () => autosize(text));
            text.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); text.blur(); }
            });
            text.addEventListener("change", () => {
                const task = tasks.find((t) => t.id === id);
                const value = text.value.trim();
                if (!task) return;
                if (!value) { text.value = task.text; autosize(text); return; } // don't allow empty tasks
                store.update(taskPath(id), { text: value });
            });

            // Priority band on the right end of the task: grey = unmarked, click to choose a colour
            const band = document.createElement("button");
            band.type = "button";
            band.className = "task-priority-band";
            band.addEventListener("click", () => {
                const task = tasks.find((t) => t.id === id);
                if (task) openPriorityMenu(band, task.priority, (p) => setPriority(id, p));
            });

            item.appendChild(checkBtn);
            item.appendChild(cancelBtn);
            item.appendChild(text);
            item.appendChild(band);
            return item;
        }

        function renderTasks() {
            const seen = new Set();
            sortedTasks().forEach((task, index) => {
                seen.add(task.id);
                let el = taskEls.get(task.id);
                if (!el) {
                    el = buildTaskEl(task.id);
                    taskEls.set(task.id, el);
                }
                el.classList.toggle("completed", task.completed);
                const prio = task.priority || "none";
                el.dataset.priority = prio;
                const band = el.querySelector(".task-priority-band");
                band.title = `Priority: ${PRIORITY_LABEL[prio].toLowerCase()} (click to change)`;
                band.setAttribute("aria-label", `Priority: ${PRIORITY_LABEL[prio].toLowerCase()}. Click to change`);
                const text = el.querySelector(".task-text");
                // Don't overwrite what someone is typing right now
                if (document.activeElement !== text && text.value !== task.text) text.value = task.text;

                if (taskList.children[index] !== el) {
                    taskList.insertBefore(el, taskList.children[index] || null);
                }
            });
            taskEls.forEach((el, id) => {
                if (!seen.has(id)) { el.remove(); taskEls.delete(id); }
            });
            autosizeAll();
        }

        store.subscribe(tasksPath, (data) => {
            tasks = Object.entries(data || {})
                .filter(([, t]) => t && typeof t.text === "string")
                .map(([id, t]) => ({
                    id, text: t.text, completed: !!t.completed, createdAt: Number(t.createdAt) || 0,
                    priority: PRIORITIES.includes(t.priority) ? t.priority : null   // missing = unmarked (older tasks)
                }))
                .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
            renderTasks();
        });

        function addTask(text) {
            const trimmed = text.trim();
            if (!trimmed) return;
            const task = { text: trimmed.slice(0, MAX_TASK_LENGTH), completed: false, createdAt: now() };
            if (entryPriority) task.priority = entryPriority;   // leave the field out entirely when unmarked
            store.set(taskPath(newId()), task);
            entryPriority = null;
            paintEntryPriority();
        }

        function setPriority(id, priority) {
            // null deletes the field in the database, i.e. back to unmarked / grey
            store.update(taskPath(id), { priority });
        }

        function paintEntryPriority() {
            const key = entryPriority || "none";
            entryPriorityBtn.dataset.priority = key;
            entryPriorityBtn.title = `Priority: ${PRIORITY_LABEL[key].toLowerCase()} (click to change)`;
        }
        entryPriorityBtn.addEventListener("click", () => {
            openPriorityMenu(entryPriorityBtn, entryPriority, (p) => { entryPriority = p; paintEntryPriority(); });
        });
        paintEntryPriority();

        /* ----- sort dropdown (top-right of the checklist) ----- */
        function paintSortMenu() {
            sortMenu.querySelectorAll(".sort-option").forEach((o) => o.classList.toggle("active", o.dataset.sort === sortMode));
        }
        function setSortOpen(open) {
            sortMenu.classList.toggle("open", open);
            sortBtn.classList.toggle("active", open);
        }
        sortBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            setSortOpen(!sortMenu.classList.contains("open"));
        });
        sortMenu.querySelectorAll(".sort-option").forEach((o) => {
            o.addEventListener("click", () => {
                sortMode = o.dataset.sort;
                try { localStorage.setItem(SORT_KEY, sortMode); } catch { /* storage blocked */ }
                paintSortMenu();
                setSortOpen(false);
                renderTasks();
            });
        });
        // click anywhere outside the dropdown closes it
        document.addEventListener("pointerdown", (e) => {
            if (!sortMenu.classList.contains("open")) return;
            if (sortMenu.contains(e.target) || sortBtn.contains(e.target)) return;
            setSortOpen(false);
        });
        paintSortMenu();

        function toggleTask(id) {
            const task = tasks.find((t) => t.id === id);
            if (!task) return;
            const completed = !task.completed;

            const summaryEntry = `${SUMMARY_PATH}/${weekKey()}/completed/${id}`;
            if (completed) {
                store.set(summaryEntry, { text: task.text, at: now(), person });
            } else {
                store.remove(summaryEntry);
            }

            store.update(taskPath(id), { completed, completedAt: completed ? now() : null });
        }

        function removeTask(id) {
            store.remove(taskPath(id)); // the weekly summary keeps tasks that were already completed
        }

        taskInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                addTask(taskInput.value);
                taskInput.value = "";
            }
        });

        // Re-measure when the layout or web font changes how the text wraps
        window.addEventListener("resize", autosizeAll);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(autosizeAll);
    }

    createChecklist(TASKS_PATH_Y, "taskInputY", "taskListY", "Yejun");
    createChecklist(TASKS_PATH_R, "taskInputR", "taskListR", "Anusri");


    /* ===================== SYNCED WEEKLY SUMMARY ===================== */

    const weekTimeEl = document.getElementById("weekTime");
    const weekCountEl = document.getElementById("weekCount");
    const summaryListEl = document.getElementById("summaryList");

    let summaryData = {};

    function renderSummary() {
        const week = summaryData[weekKey()] || {};
        const minutes = Number(week.minutes) || 0;
        const completed = Object.values(week.completed || {})
            .filter((c) => c && typeof c.text === "string")
            .sort((a, b) => (a.at || 0) - (b.at || 0));

        weekTimeEl.textContent = `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
        weekCountEl.textContent = completed.length;

        summaryListEl.innerHTML = "";
        if (completed.length === 0) {
            const empty = document.createElement("div");
            empty.className = "summary-empty";
            empty.textContent = "No tasks completed yet this week";
            summaryListEl.appendChild(empty);
            return;
        }
        completed.forEach((c) => {
            const item = document.createElement("div");
            item.className = "summary-item";
            item.textContent = c.text;
            summaryListEl.appendChild(item);
        });
    }

    store.subscribe(SUMMARY_PATH, (data) => {
        summaryData = data || {};
        renderSummary();
    });

    // Switch to a fresh (empty) week automatically if the page is left open over Sunday night
    setInterval(renderSummary, 60000);

    function addFocusedMinutes(minutes) {
        store.transaction(`${SUMMARY_PATH}/${weekKey()}/minutes`, (current) => (Number(current) || 0) + minutes);
    }

    /* ===================== COMPLETED TASKS JAR ===================== */

    const jarPanelEl     = document.getElementById("jarPanel");
    const jarWrapEl      = document.getElementById("jarWrap");
    const jarSlipsEl     = document.getElementById("jarSlips");
    const jarSpillEl     = document.getElementById("jarSpill");
    const jarScatteredEl = document.getElementById("jarScattered");
    const jarBlurEl      = document.getElementById("jarBlur");
    const jarCounterEl   = document.getElementById("jarCounter");
    const jarEmptyHintEl = document.getElementById("jarEmptyHint");
    const jarEmptyBtn    = document.getElementById("jarEmptyBtn");
    const jarListBtn     = document.getElementById("jarListBtn");
    const jarWeeksEl     = document.getElementById("jarWeeks");
    const jarWeeksListEl = document.getElementById("jarWeeksList");

    const JAR_CAPACITY = 21;   // slips that fill the jar to the brim
    const SLIP_W = 36;
    const SLIP_H = 18;

    let jarEmptied = false;
    let activeUnfolded = null;
    let jarSummary = {};
    let scatteredTasks = [];

    const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const jrand = (a, b) => Math.random() * (b - a) + a;

    /* ---------- data helpers ---------- */

    function getWeekCompleted() {
        const week = jarSummary[weekKey()] || {};
        return Object.entries(week.completed || {})
            .filter(([, c]) => c && typeof c.text === "string")
            .map(([id, c]) => ({
                id,
                text: c.text,
                at: Number(c.at) || 0,
                person: c.person === "gf" ? "gf" : "me"
            }))
            .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    }

    function weekLabelFromKey(key) {
        const m = /^(\d{4})-W(\d{2})$/.exec(key);
        if (!m) return key;
        const year = Number(m[1]);
        const week = Number(m[2]);
        const jan4 = new Date(year, 0, 4);
        const jan4Mon = (jan4.getDay() + 6) % 7;          // Mon = 0
        const week1Mon = new Date(jan4);
        week1Mon.setDate(jan4.getDate() - jan4Mon);
        const mon = new Date(week1Mon);
        mon.setDate(week1Mon.getDate() + (week - 1) * 7);
        const sun = new Date(mon);
        sun.setDate(mon.getDate() + 6);
        const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
        return `${fmt(mon)} – ${fmt(sun)}, ${mon.getFullYear()}`;
    }

    /* ---------- slip factory ---------- */

    function buildSlipEl(task) {
        const el = document.createElement("div");
        el.className = "jar-slip";
        el.dataset.person = task.person;
        el.addEventListener("click", (e) => {
            e.stopPropagation();
            unfoldSlip(el, task);
        });
        return el;
    }

    /* ---------- jar rendering ---------- */

    function renderJar() {
        if (jarEmptied) return;
        jarSlipsEl.innerHTML = "";
        jarSpillEl.innerHTML = "";

        const tasks = getWeekCompleted();
        const count = tasks.length;
        jarCounterEl.textContent = count + (count === 1 ? " task" : " tasks");
        jarEmptyHintEl.classList.toggle("hidden", count > 0);

        const layerW = jarSlipsEl.clientWidth || 155;
        const layerH = jarSlipsEl.clientHeight || 165;

        /* three centred columns inside the glass */
        const cols = 3;
        const gap = Math.min(12, Math.max(2, (layerW - cols * SLIP_W) / (cols - 1)));
        const rowW = cols * SLIP_W + (cols - 1) * gap;
        const startX = (layerW - rowW) / 2;
        const rowGap = SLIP_H + 3;
        const baseY = layerH - SLIP_H - 2;

        tasks.slice(0, JAR_CAPACITY).forEach((task, i) => {
            const el = buildSlipEl(task);
            const r = Math.floor(i / cols);
            const c = i % cols;
            el.style.left = (startX + c * (SLIP_W + gap) + jrand(-2, 2)) + "px";
            el.style.top  = (baseY - r * rowGap + jrand(-2, 2)) + "px";
            el.style.setProperty("--rot", jrand(-16, 16) + "deg");
            jarSlipsEl.appendChild(el);
        });

        /* extras spill around the rim, evenly distributed across the width */
        const spilled = tasks.slice(JAR_CAPACITY, JAR_CAPACITY + 6);
        const wrapW = jarSpillEl.clientWidth || 160;
        const n = spilled.length;
        if (n) {
            const slot = wrapW / n;
            spilled.forEach((task, k) => {
                const el = buildSlipEl(task);
                el.style.left = (slot * k + (slot - SLIP_W) / 2 + jrand(-3, 3)) + "px";
                el.style.top  = jrand(8, 22) + "px";
                el.style.setProperty("--rot", jrand(-55, 55) + "deg");
                jarSpillEl.appendChild(el);
            });
        }
    }

    /* ---------- empty / restore ---------- */

    function emptyJar() {
        if (jarEmptied) return;
        const tasks = getWeekCompleted();
        if (!tasks.length) return;

        jarEmptied = true;
        closeUnfolded();
        closeWeeks();
        jarEmptyHintEl.classList.add("hidden");
        jarWrapEl.classList.add("tilted");
        jarEmptyBtn.title = "Back to jar";

        setTimeout(() => {
            jarWrapEl.classList.add("hidden");
            jarScatteredEl.classList.add("active");
            layoutScattered(tasks);
        }, 520);
    }

    function layoutScattered(tasks) {
        scatteredTasks = tasks;
        jarScatteredEl.innerHTML = "";

        const W = jarScatteredEl.clientWidth;
        const H = jarScatteredEl.clientHeight;
        const n = tasks.length;
        if (!n || !W || !H) return;

        const padX = 34, padY = 50;
        const availW = Math.max(80, W - padX * 2);
        const availH = Math.max(80, H - padY * 2);

        const cellW = SLIP_W + 18;   // 18 px horizontal breathing room
        const cellH = SLIP_H + 18;

        const maxCols = Math.max(1, Math.floor(availW / cellW));
        const maxRows = Math.max(1, Math.floor(availH / cellH));

        let cols = Math.min(maxCols, n);
        let rows = Math.ceil(n / cols);
        while (rows > maxRows && cols < n) {
            cols++;
            rows = Math.ceil(n / cols);
        }
        cols = Math.min(cols, maxCols);
        rows = Math.ceil(n / cols);

        /* centre the whole grid both ways */
        const gridH = rows * cellH;
        const originY = (H - gridH) / 2;

        tasks.forEach((task, i) => {
            const r = Math.floor(i / cols);
            const c = i % cols;
            /* last row is centred on its own */
            const itemsInRow = Math.min(cols, n - r * cols);
            const rowX = (W - itemsInRow * cellW) / 2;

            const x = rowX + c * cellW + (cellW - SLIP_W) / 2 + jrand(-3, 3);
            const y = originY + r * cellH + (cellH - SLIP_H) / 2 + jrand(-3, 3);

            const el = buildSlipEl(task);
            el.style.left = x + "px";
            el.style.top  = y + "px";
            el.style.setProperty("--rot", jrand(-14, 14) + "deg");
            jarScatteredEl.appendChild(el);
        });
    }

    function restoreJar() {
        if (!jarEmptied) return;
        jarEmptied = false;
        closeUnfolded();
        jarScatteredEl.classList.remove("active");
        jarScatteredEl.innerHTML = "";
        scatteredTasks = [];
        jarWrapEl.classList.remove("hidden", "tilted");
        jarEmptyBtn.title = "Empty jar";
        renderJar();
    }

    /* ---------- unfold / fold ---------- */

    function unfoldSlip(slipEl, task) {
        if (activeUnfolded) return;
        closeWeeks();

        const panelRect = jarPanelEl.getBoundingClientRect();
        const slipRect  = slipEl.getBoundingClientRect();

        /* offset from the panel centre to the slip centre, so the modal grows out of the slip */
        const dx = (slipRect.left + slipRect.width / 2) - (panelRect.left + panelRect.width / 2);
        const dy = (slipRect.top + slipRect.height / 2) - (panelRect.top + panelRect.height / 2);

        const modal = document.createElement("div");
        modal.className = "jar-slip unfolded";
        modal.dataset.person = task.person;
        modal.innerHTML =
            `<div class="task-text">${escHtml(task.text)}</div>` +
            `<div class="task-meta">${task.person === "gf" ? "Ri" : "Yejun"}</div>`;

        modal.style.transform =
            `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.15)`;
        modal.style.opacity = "0.55";

        jarPanelEl.appendChild(modal);
        activeUnfolded = modal;
        modal._sourceSlip = slipEl;
        jarBlurEl.classList.add("active");

        requestAnimationFrame(() => {
            modal.style.transform = "translate(-50%, -50%) scale(1)";
            modal.style.opacity = "1";
        });

        const onDocDown = (e) => {
            if (modal.contains(e.target)) return;
            closeUnfolded();
        };
        modal._onDocDown = onDocDown;
        setTimeout(() => {
            if (activeUnfolded === modal) document.addEventListener("pointerdown", onDocDown, true);
        }, 150);
    }

    function closeUnfolded() {
        if (!activeUnfolded) return;
        const modal = activeUnfolded;
        activeUnfolded = null;

        if (modal._onDocDown) {
            document.removeEventListener("pointerdown", modal._onDocDown, true);
        }

        /* shrink back toward the slip it came from */
        const src = modal._sourceSlip;
        if (src && src.isConnected) {
            const panelRect = jarPanelEl.getBoundingClientRect();
            const r = src.getBoundingClientRect();
            const dx = (r.left + r.width / 2) - (panelRect.left + panelRect.width / 2);
            const dy = (r.top + r.height / 2) - (panelRect.top + panelRect.height / 2);
            modal.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.15)`;
        } else {
            modal.style.transform = "translate(-50%, -50%) scale(0.15)";
        }
        modal.style.opacity = "0";

        setTimeout(() => {
            if (modal.parentNode) modal.parentNode.removeChild(modal);
            jarBlurEl.classList.remove("active");
        }, 360);
    }

    /* ---------- weeks dropdown ---------- */

    /* Anchor: Monday of ISO week 42 of 2026 (Sep 28 – Oct 4, 2026). */
    const WEEKS_ANCHOR = "2026-09-28";

    function allWeeksUpToNow() {
        const anchor = new Date(WEEKS_ANCHOR + "T12:00:00");
        const today  = new Date(now());
        const keys = [];
        const seen = new Set();
        const cursor = new Date(anchor);
        while (cursor <= today) {
            const k = weekKeyFor(cursor.getTime());
            if (!seen.has(k)) { seen.add(k); keys.push(k); }
            cursor.setDate(cursor.getDate() + 7);
        }
        return keys.reverse();   // newest first
    }

    function renderWeeks() {
        const allKeys = allWeeksUpToNow();
        jarWeeksListEl.innerHTML = "";

        allKeys.forEach((key) => {
            const week  = jarSummary[key] || {};
            const items = Object.values(week.completed || {})
                .filter((c) => c && typeof c.text === "string")
                .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));

            const section = document.createElement("div");
            section.className = "jar-week";

            const head = document.createElement("div");
            head.className = "jar-week-head";
            head.innerHTML =
                `<span class="jar-week-label">Week of ${weekLabelFromKey(key)}</span>` +
                `<span class="jar-week-count">${items.length} task${items.length === 1 ? "" : "s"}</span>`;
            section.appendChild(head);

            const list = document.createElement("div");
            list.className = "jar-week-tasks";

            if (!items.length) {
                const empty = document.createElement("div");
                empty.className = "jar-week-task empty";
                empty.textContent = "No tasks completed";
                list.appendChild(empty);
            } else {
                items.forEach((it) => {
                    const row = document.createElement("div");
                    row.className = "jar-week-task";
                    row.dataset.person = it.person === "gf" ? "gf" : "me";
                    row.innerHTML = `<span class="dot"></span><span>${escHtml(it.text)}</span>`;
                    list.appendChild(row);
                });
            }

            section.appendChild(list);
            jarWeeksListEl.appendChild(section);
        });
    }

    function openWeeks() {
        renderWeeks();
        jarWeeksEl.classList.add("open");
        jarListBtn.classList.add("active");
    }

    function closeWeeks() {
        jarWeeksEl.classList.remove("open");
        jarListBtn.classList.remove("active");
    }

    /* ---------- wiring ---------- */

    jarEmptyBtn.addEventListener("click", () => {
        if (jarEmptied) restoreJar();
        else emptyJar();
    });

    jarListBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (jarWeeksEl.classList.contains("open")) closeWeeks();
        else openWeeks();
    });

    jarBlurEl.addEventListener("click", closeUnfolded);

    /* click anywhere outside the dropdown closes it */
    document.addEventListener("pointerdown", (e) => {
        if (!jarWeeksEl.classList.contains("open")) return;
        if (jarWeeksEl.contains(e.target)) return;
        if (jarListBtn.contains(e.target)) return;
        closeWeeks();
    });

    /* keep the layout correct if the panel changes size */
    let jarResizeTimer = null;
    window.addEventListener("resize", () => {
        clearTimeout(jarResizeTimer);
        jarResizeTimer = setTimeout(() => {
            if (!jarEmptied) renderJar();
            else if (jarScatteredEl.classList.contains("active")) layoutScattered(scatteredTasks);
        }, 160);
    });

    /* re-render whenever the weekly summary changes (both checklists write here) */
    store.subscribe(SUMMARY_PATH, (data) => {
        jarSummary = data || {};
        if (!jarEmptied) renderJar();
        if (jarWeeksEl.classList.contains("open")) renderWeeks();
    });

    /* ===================== WEEKLY CLEANUP ===================== */
    // Removes completed tasks from the checklists once their completion week has passed.
    // Runs when the page loads (so it applies to existing completed tasks immediately)
    // and every minute, so a page left open over Sunday night cleans itself up.

    const sweepTasks = { [TASKS_PATH_Y]: null, [TASKS_PATH_R]: null };
    let sweepSummary = {};
    let sweepReady = false;

    function completionWeekOf(id, task) {
        if (task.completedAt) return weekKeyFor(Number(task.completedAt));
        // Older tasks have no completedAt, so look them up in the weekly summary
        for (const [wk, w] of Object.entries(sweepSummary)) {
            if (w && w.completed && w.completed[id]) return wk;
        }
        return null;
    }

    function sweepCompleted() {
        if (!sweepReady) return;
        const current = weekKey();
        Object.entries(sweepTasks).forEach(([path, tasks]) => {
            if (!tasks) return;
            Object.entries(tasks).forEach(([id, t]) => {
                if (!t || !t.completed) return;
                const wk = completionWeekOf(id, t);
                if (wk !== null && wk < current) store.remove(`${path}/${id}`);
            });
        });
    }

    [TASKS_PATH_Y, TASKS_PATH_R].forEach((path) => {
        store.subscribe(path, (data) => {
            sweepTasks[path] = data || {};
            sweepCompleted();
        });
    });

    store.subscribe(SUMMARY_PATH, (data) => {
        sweepSummary = data || {};
        sweepReady = true;
        sweepCompleted();
    });

    setInterval(sweepCompleted, 60000);

    /* ===================== NOTES (toolbar + View / Send Message) ===================== */
    window.PomodoroNotes.init({ store, role: session.role, now });
});
