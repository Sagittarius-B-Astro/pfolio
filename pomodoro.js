document.addEventListener("DOMContentLoaded", function () {

    const firebaseConfig = {
        apiKey: "AIzaSyCooSZBdLitNjZkY1MIdsM6iW_67jPQq6Y",
        authDomain: "pomodoro-with-gf.firebaseapp.com",
        databaseURL: "https://pomodoro-with-gf-default-rtdb.firebaseio.com",
        projectId: "pomodoro-with-gf",
        appId: "1:580176160630:web:0931e9e945fcf82785fc57"
    };

    function createLocalRef() {
        let value = null;
        const listeners = [];
        const snap = () => ({ val: () => (value === null ? null : { ...value }) });
        return {
            set(v) {
                value = { ...v };
                listeners.forEach((cb) => cb(snap()));
                return Promise.resolve();
            },
            on(_event, cb) {
                listeners.push(cb);
                setTimeout(() => cb(snap()), 0);
            }
        };
    }

    const firebaseConfigured =
        typeof firebase !== "undefined" &&
        Object.values(firebaseConfig).every((v) => v && !v.startsWith("__"));

    let stateRef = null;
    if (firebaseConfigured) {
        try {
            firebase.initializeApp(firebaseConfig);
            stateRef = firebase.database().ref("pomodoroState");
        } catch (err) {
            console.error("Firebase failed to initialize:", err);
        }
    }
    if (!stateRef) {
        console.warn("Firebase not configured - running the timer in local-only mode.");
        stateRef = createLocalRef();
    }

    const DURATION = 25 * 60;

    const timerDisplay = document.getElementById("timerDisplay");
    const toggleBtn = document.getElementById("toggleBtn");
    const resetBtn = document.getElementById("resetBtn");

    let remoteState = { running: false, endTime: null, remaining: DURATION };
    let sessionCounted = false;

    function formatTime(totalSeconds) {
        const s = Math.max(0, Math.round(totalSeconds));
        const mm = Math.floor(s / 60).toString().padStart(2, "0");
        const ss = (s % 60).toString().padStart(2, "0");
        return `${mm}:${ss}`;
    }

    function secondsLeft() {
        if (remoteState.running && remoteState.endTime) {
            return Math.max(0, (remoteState.endTime - Date.now()) / 1000);
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

        if (remoteState.running && left <= 0 && !sessionCounted) {
            sessionCounted = true;
            recordFocusedMinutes(DURATION / 60);
            stateRef.set({ running: false, endTime: null, remaining: 0 });
        }
    }

    stateRef.on("value", (snapshot) => {
        const data = snapshot.val();
        if (!data) {
            stateRef.set({ running: false, endTime: null, remaining: DURATION });
            return;
        }
        remoteState = data;
        sessionCounted = false;
        renderTimer();
    });

    setInterval(renderTimer, 250);

    toggleBtn.addEventListener("click", () => {
        if (remoteState.running) {
            stateRef.set({ running: false, endTime: null, remaining: secondsLeft() });
        } else {
            const left = remoteState.remaining || DURATION;
            const remaining = left > 0 ? left : DURATION;
            const endTime = Date.now() + remaining * 1000;
            stateRef.set({ running: true, endTime, remaining });
        }
    });

    resetBtn.addEventListener("click", () => {
        stateRef.set({ running: false, endTime: null, remaining: DURATION });
    });


    /* ===================== CHECKLIST (per-browser) ===================== */

    const taskInput = document.getElementById("taskInput");
    const taskList = document.getElementById("taskList");

    function loadTasks() {
        try {
            return JSON.parse(localStorage.getItem("pomodoroTasks")) || [];
        } catch {
            return [];
        }
    }

    function saveTasks(tasks) {
        localStorage.setItem("pomodoroTasks", JSON.stringify(tasks));
    }

    let tasks = loadTasks();

    function renderTasks() {
        taskList.innerHTML = "";
        tasks.forEach((task) => {
            const item = document.createElement("div");
            item.className = "task-item" + (task.completed ? " completed" : "");

            const checkBtn = document.createElement("button");
            checkBtn.className = "task-check-btn";
            checkBtn.innerHTML = '<i class="fas fa-check"></i>';
            checkBtn.addEventListener("click", () => toggleTask(task.id));

            const cancelBtn = document.createElement("button");
            cancelBtn.className = "task-cancel-btn";
            cancelBtn.innerHTML = '<i class="fas fa-xmark"></i>';
            cancelBtn.addEventListener("click", () => removeTask(task.id));

            const text = document.createElement("input");
            text.type = "text";
            text.className = "task-text";
            text.value = task.text;
            text.addEventListener("change", () => {
                task.text = text.value;
                saveTasks(tasks);
            });

            item.appendChild(checkBtn);
            item.appendChild(cancelBtn);
            item.appendChild(text);
            taskList.appendChild(item);
        });
    }

    function addTask(text) {
        const trimmed = text.trim();
        if (!trimmed) return;
        tasks.push({ id: Date.now().toString(), text: trimmed, completed: false });
        saveTasks(tasks);
        renderTasks();
    }

    function toggleTask(id) {
        const task = tasks.find((t) => t.id === id);
        if (!task) return;
        task.completed = !task.completed;
        saveTasks(tasks);
        renderTasks();
        if (task.completed) {
            recordCompletedTask(task.text);
        }
    }

    function removeTask(id) {
        tasks = tasks.filter((t) => t.id !== id);
        saveTasks(tasks);
        renderTasks();
    }

    taskInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            addTask(taskInput.value);
            taskInput.value = "";
        }
    });

    renderTasks();

    const weekTimeEl = document.getElementById("weekTime");
    const weekCountEl = document.getElementById("weekCount");
    const summaryListEl = document.getElementById("summaryList");

    function currentWeekKey() {
        const now = new Date();
        const jan1 = new Date(now.getFullYear(), 0, 1);
        const days = Math.floor((now - jan1) / 86400000);
        const week = Math.ceil((days + jan1.getDay() + 1) / 7);
        return `${now.getFullYear()}-W${week}`;
    }

    function loadSummary() {
        let summary;
        try {
            summary = JSON.parse(localStorage.getItem("pomodoroSummary"));
        } catch {
            summary = null;
        }
        const key = currentWeekKey();
        if (!summary || summary.week !== key) {
            summary = { week: key, minutes: 0, completed: [] };
        }
        return summary;
    }

    let summary = loadSummary();

    function saveSummary() {
        localStorage.setItem("pomodoroSummary", JSON.stringify(summary));
    }

    function renderSummary() {
        const hours = Math.floor(summary.minutes / 60);
        const mins = Math.round(summary.minutes % 60);
        weekTimeEl.textContent = `${hours}h ${mins}m`;
        weekCountEl.textContent = summary.completed.length;

        summaryListEl.innerHTML = "";
        if (summary.completed.length === 0) {
            const empty = document.createElement("div");
            empty.className = "summary-empty";
            empty.textContent = "No tasks completed yet this week";
            summaryListEl.appendChild(empty);
            return;
        }
        summary.completed.forEach((text) => {
            const item = document.createElement("div");
            item.className = "summary-item";
            item.textContent = text;
            summaryListEl.appendChild(item);
        });
    }

    function recordFocusedMinutes(minutes) {
        summary = loadSummary();
        summary.minutes += minutes;
        saveSummary();
        renderSummary();
    }

    function recordCompletedTask(text) {
        summary = loadSummary();
        summary.completed.push(text);
        saveSummary();
        renderSummary();
    }

    renderSummary();
});
