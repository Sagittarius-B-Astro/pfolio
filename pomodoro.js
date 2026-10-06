document.addEventListener("DOMContentLoaded", function () {

    /* ===================== CONFIG ===================== */

    // Placeholders are swapped for real values by the GitHub Actions workflow at deploy time.
    const firebaseConfig = {
        apiKey: "AIzaSyCooSZBdLitNjZkY1MIdsM6iW_67jPQq6Y",
        authDomain: "pomodoro-with-gf.firebaseapp.com",
        databaseURL: "https://pomodoro-with-gf-default-rtdb.firebaseio.com",
        projectId: "pomodoro-with-gf",
        appId: "1:580176160630:web:0931e9e945fcf82785fc57"
    };

    const DURATION = 25 * 60;      // seconds
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

    // Use the database server's clock so users with slightly-off computer clocks stay in sync
    let serverOffset = 0;
    store.onServerOffset((offset) => { serverOffset = offset; });
    const now = () => Date.now() + serverOffset;

    // Week identifier, e.g. "2026-W40" (weeks start on Monday, in the viewer's local time)
    function weekKey() {
        const d = new Date(now());
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7)); // Thursday of this week
        const week1 = new Date(d.getFullYear(), 0, 4);
        const week = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
        return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
    }


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

    function playBell() {
        if (!audioCtx) return;
        try {
            const t0 = audioCtx.currentTime;
            [880, 1320].forEach((freq, i) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = "sine";
                osc.frequency.value = freq;
                const start = t0 + i * 0.15;
                gain.gain.setValueAtTime(0.0001, start);
                gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
                gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.2);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(start);
                osc.stop(start + 1.3);
            });
        } catch (err) {
            console.error("Could not play the bell sound:", err);
        }
    }


    /* ===================== SYNCED TIMER ===================== */

    const timerDisplay = document.getElementById("timerDisplay");    
    const toggleBtn = document.getElementById("toggleBtn");
    const resetBtn = document.getElementById("resetBtn");

    let remoteState = { running: false, endTime: null, remaining: DURATION };
    let finishing = false; // true while a "timer hit zero" transaction is in flight

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
        return remoteState.remaining ?? DURATION;
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
            // Every open page notices the timer hit zero, but the transaction only commits for the
            // first one - so the focused time is counted once, not once per user.
            store.transaction(STATE_PATH, (current) => {
                if (current === null) return current;
                if (current.running && current.endTime && current.endTime <= now()) {
                    return { running: false, endTime: null, remaining: 0 };
                }
                return undefined; // someone else already handled it
            }).then((result) => {
                if (result.committed) addFocusedMinutes(DURATION / 60);
            });
        }
    }

    store.subscribe(STATE_PATH, (data) => {
        if (!data) {
            store.set(STATE_PATH, { running: false, endTime: null, remaining: DURATION });
            return;
        }
        const wasRunning = remoteState.running;
        remoteState = data;
        finishing = false;
        // Every open page (not just whichever one's transaction "won") sees this
        // transition and rings its own bell - a real-finish, not a manual pause.
        if (wasRunning && !data.running && (data.remaining || 0) <= 0) {
            playBell();
        }
        renderTimer();
    });

    setInterval(renderTimer, 250);

    toggleBtn.addEventListener("click", () => {
        unlockAudio();
        if (remoteState.running) {
            store.set(STATE_PATH, { running: false, endTime: null, remaining: secondsLeft() });
        } else {
            const left = remoteState.remaining || DURATION;
            const remaining = left > 0 ? left : DURATION;
            store.set(STATE_PATH, { running: true, endTime: now() + remaining * 1000, remaining });
        }
    });

    resetBtn.addEventListener("click", () => {
        store.set(STATE_PATH, { running: false, endTime: null, remaining: DURATION });
    });


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

    // One independent checklist: its own database path, its own input/list elements,
    // its own in-memory task array. Completions from either checklist still feed the
    // one shared weekly summary below.
    function createChecklist(tasksPath, inputId, listId) {
        const taskInput = document.getElementById(inputId);
        const taskList = document.getElementById(listId);
        taskInput.maxLength = MAX_TASK_LENGTH;

        let tasks = [];                 // sorted array built from the database
        const taskEls = new Map();      // task id -> its DOM element

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

            item.appendChild(checkBtn);
            item.appendChild(cancelBtn);
            item.appendChild(text);
            return item;
        }

        function renderTasks() {
            const seen = new Set();
            tasks.forEach((task, index) => {
                seen.add(task.id);
                let el = taskEls.get(task.id);
                if (!el) {
                    el = buildTaskEl(task.id);
                    taskEls.set(task.id, el);
                }
                el.classList.toggle("completed", task.completed);
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
                .map(([id, t]) => ({ id, text: t.text, completed: !!t.completed, createdAt: Number(t.createdAt) || 0 }))
                .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
            renderTasks();
        });

        function addTask(text) {
            const trimmed = text.trim();
            if (!trimmed) return;
            store.set(taskPath(newId()), { text: trimmed.slice(0, MAX_TASK_LENGTH), completed: false, createdAt: now() });
        }

        function toggleTask(id) {
            const task = tasks.find((t) => t.id === id);
            if (!task) return;
            const completed = !task.completed;
            store.update(taskPath(id), { completed });
            // Keyed by task id, so checking / unchecking never creates duplicate summary entries
            const summaryEntry = `${SUMMARY_PATH}/${weekKey()}/completed/${id}`;
            if (completed) store.set(summaryEntry, { text: task.text, at: now() });
            else store.remove(summaryEntry);
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

    createChecklist(TASKS_PATH_Y, "taskInputY", "taskListY");
    createChecklist(TASKS_PATH_R, "taskInputR", "taskListR");


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
});
