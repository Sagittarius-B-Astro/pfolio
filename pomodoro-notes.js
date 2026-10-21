/* pomodoro-notes.js
   Two features that sit on top of pomodoro.js:
     1. window.PomodoroAuth  - login gate (only the two allowed accounts get in)
     2. window.PomodoroNotes - top-right toolbar + View / Send Message modals
   pomodoro.js calls PomodoroAuth.require() before it starts listening to the database,
   then PomodoroNotes.init() once everything else is running. */
(function () {
    "use strict";

    // Who is who is NOT stored in this file. After login, the role ("me" / "gf" - the same values
    // pomodoro.js already uses) is read from the database node userRoles/<uid>, which only the
    // Firebase console can edit.
    const NAMES = { me: "Yejun", gf: "Ri" };
    const MESSAGES_PATH = "pomodoroMessages";   // database path: pomodoroMessages/<id> = {from, text, at}
    const MAX_LENGTH = 1000;
    const LOCAL_KEY = "pomodoroLocalUser";
    const NEW = "__new__";                      // select value for the "New message" entry

    // Hide the page immediately; unlocked once login succeeds.
    document.documentElement.classList.add("locked");

    /* ---------- tiny helpers ---------- */

    // Create an element with an optional class and text.
    function el(tag, className, text) {
        const n = document.createElement(tag);
        if (className) n.className = className;
        if (text !== undefined) n.textContent = text;
        return n;
    }
    // "Oct 20, 3:41 PM" in the viewer's locale.
    function stamp(ms) {
        return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }
    function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }


    /* ===================== LOGIN ===================== */

    // Builds the full-screen login card and returns the overlay element.
    function buildLogin() {
        const overlay = el("div", "auth-overlay checking");
        overlay.innerHTML =
            '<form class="auth-card">' +
              '<div class="auth-title"><span>Pomodoro</span><i class="fas fa-heart title-heart"></i></div>' +
              '<input type="email" name="email" class="form-control task-input" placeholder="email" autocomplete="username" required>' +
              '<input type="password" name="password" class="form-control task-input" placeholder="password" autocomplete="current-password" required>' +
              '<div class="auth-error" role="alert"></div>' +
              '<button type="submit" class="btn control-btn auth-submit">Log in</button>' +
              '<div class="auth-note"></div>' +
            '</form>';
        document.body.appendChild(overlay);
        return overlay;
    }

    window.PomodoroAuth = {
        // Resolves with { role } once a permitted user is signed in. Nothing after this point in
        // pomodoro.js runs before then, so no data is read while logged out.
        require(store) {
            return new Promise((resolve) => {
                const overlay = buildLogin();
                const form = overlay.querySelector("form");
                const emailEl = form.elements.email, passEl = form.elements.password;
                const errEl = overlay.querySelector(".auth-error");
                const btn = overlay.querySelector(".auth-submit");
                const note = overlay.querySelector(".auth-note");
                let done = false;

                const unlock = (role) => {
                    if (done) return;
                    done = true;
                    overlay.remove();
                    document.documentElement.classList.remove("locked");
                    resolve({ role });
                };
                const fail = (msg) => { errEl.textContent = msg; btn.disabled = false; };

                if (store.mode === "firebase") {
                    if (!firebase.auth) { overlay.classList.remove("checking"); fail("Login library failed to load."); return; }
                    const auth = firebase.auth();
                    // Fires once on load (restoring a saved session, or null) and again after each login
                    auth.onAuthStateChanged((user) => {
                        overlay.classList.remove("checking");
                        if (!user) return;
                        // Signed in - but only accounts listed in userRoles may enter
                        firebase.database().ref("userRoles/" + user.uid).once("value")
                            .then((snap) => {
                                const role = snap.val();
                                if (role !== "me" && role !== "gf") throw new Error("no role");
                                unlock(role);
                            })
                            .catch(() => { auth.signOut(); fail("This account isn't allowed here."); });
                    });
                    form.addEventListener("submit", (e) => {
                        e.preventDefault();
                        errEl.textContent = ""; btn.disabled = true;
                        auth.signInWithEmailAndPassword(emailEl.value.trim(), passEl.value)
                            .catch(() => fail("Incorrect email or password."));
                    });
                } else {
                    // Local test mode (Firebase not configured): no credentials, just pick who to test as
                    overlay.classList.remove("checking");
                    note.textContent = "Local test mode: no password check.";
                    const saved = sessionStorage.getItem(LOCAL_KEY);
                    if (saved === "me" || saved === "gf") { unlock(saved); return; }
                    form.querySelectorAll("input, .auth-submit").forEach((n) => { n.hidden = true; });
                    ["me", "gf"].forEach((r) => {
                        const b = el("button", "btn control-btn auth-submit", "Test as " + NAMES[r]);
                        b.type = "button";
                        b.addEventListener("click", () => { sessionStorage.setItem(LOCAL_KEY, r); unlock(r); });
                        form.insertBefore(b, note);
                    });
                }
            });
        },

        // Signs out and reloads so the login gate comes back with all listeners cleared.
        signOut(store) {
            if (store.mode === "firebase" && firebase.auth) {
                firebase.auth().signOut().finally(() => location.reload());
            } else {
                sessionStorage.removeItem(LOCAL_KEY);
                location.reload();
            }
        }
    };


    /* ===================== NOTES ===================== */

    window.PomodoroNotes = {
        init({ store, role, now }) {
            const other = role === "me" ? "gf" : "me";
            const borderClass = role === "gf" ? "border-rose" : "border-fern";
            let messages = [];     // all messages, newest first
            let openModal = null;  // { close, refresh } for whichever modal is showing

            /* ----- toolbar: notes dropdown + logout ----- */
            const toolbar = el("div", "notes-toolbar");
            const menu = el("div", "notes-menu");
            const noteBtn = el("button", "notes-btn");
            noteBtn.type = "button";
            noteBtn.title = "Notes";
            noteBtn.setAttribute("aria-haspopup", "true");
            noteBtn.setAttribute("aria-expanded", "false");
            noteBtn.innerHTML = '<i class="fas fa-note-sticky"></i>';
            const dropdown = el("div", "notes-dropdown");
            dropdown.innerHTML =
                '<button type="button" data-act="view"><i class="fas fa-envelope-open"></i>View Message</button>' +
                '<button type="button" data-act="send"><i class="fas fa-pen"></i>Send Message</button>';
            menu.append(noteBtn, dropdown);

            const logoutBtn = el("button", "notes-btn");
            logoutBtn.type = "button";
            logoutBtn.title = "Log out";
            logoutBtn.setAttribute("aria-label", "Log out");
            logoutBtn.innerHTML = '<i class="fas fa-right-from-bracket"></i>';
            toolbar.append(menu, logoutBtn);
            document.body.appendChild(toolbar);

            function setMenu(open) {
                menu.classList.toggle("open", open);
                noteBtn.setAttribute("aria-expanded", open);
            }
            noteBtn.addEventListener("click", (e) => { e.stopPropagation(); setMenu(!menu.classList.contains("open")); });
            document.addEventListener("click", () => setMenu(false));
            dropdown.addEventListener("click", (e) => {
                const b = e.target.closest("button[data-act]");
                if (!b) return;
                setMenu(false);
                showModal(b.dataset.act);
            });
            logoutBtn.addEventListener("click", () => window.PomodoroAuth.signOut(store));

            /* ----- messages from the database ----- */
            store.subscribe(MESSAGES_PATH, (data) => {
                messages = Object.entries(data || {})
                    .filter(([, m]) => m && typeof m.text === "string")
                    .map(([id, m]) => ({ id, text: m.text, from: m.from === "gf" ? "gf" : "me", at: Number(m.at) || 0 }))
                    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
                if (openModal) openModal.refresh();   // live-update an open modal
            });

            /* ----- the modal (one function builds both View and Send) ----- */
            function showModal(mode) {
                if (openModal) openModal.close();
                const isView = mode === "view";

                // View shows what the OTHER person sent me; Send shows what I sent.
                const items = () => messages.filter((m) => m.from === (isView ? other : role));

                const overlay = el("div", "note-overlay theme-" + role);
                const frame = el("div", "note-frame" + (isView ? " has-border " + borderClass : ""));
                const paper = el("div", "note-paper");

                const side = el("div", "note-side");
                const label = el("label", "note-label", isView ? "Messages from " + NAMES[other] : "Messages you sent");
                const select = el("select", "note-select");
                select.id = "noteSelect";
                label.htmlFor = "noteSelect";
                side.append(label, select);

                const main = el("div", "note-main");
                const meta = el("div", "note-meta");
                const text = el("div", "note-text");
                const input = el("textarea", "note-input");
                input.maxLength = MAX_LENGTH;
                input.placeholder = "Write a message…";
                input.setAttribute("aria-label", "Message");
                const actions = el("div", "note-actions");
                const status = el("span", "note-status");
                const sendBtn = el("button", "btn control-btn note-send");
                sendBtn.type = "button";
                sendBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Send message';
                actions.append(status, sendBtn);
                main.append(meta, text, input, actions);
                paper.append(side, main);

                const closeBtn = el("button", "note-close", "×");
                closeBtn.type = "button";
                closeBtn.setAttribute("aria-label", "Close");
                frame.append(paper, closeBtn);
                overlay.appendChild(frame);
                document.body.appendChild(overlay);

                let userPicked = false;   // once the user chooses an entry, stop auto-jumping to the newest

                // Rebuild the dropdown, keep the user's pick if still there, otherwise use the default
                function refresh() {
                    const list = items();
                    const prev = select.value;
                    select.innerHTML = "";
                    if (!isView) select.add(new Option("✎ New message", NEW));
                    list.forEach((m) => select.add(new Option(stamp(m.at), m.id)));
                    const stillThere = [...select.options].some((o) => o.value === prev);
                    select.value = userPicked && stillThere ? prev : (isView ? (list[0] ? list[0].id : "") : NEW);
                    select.disabled = isView && !list.length;
                    render(list);
                }

                // Show the selected message (or the composer)
                function render(list) {
                    const composing = !isView && select.value === NEW;
                    input.hidden = !composing;
                    sendBtn.hidden = !composing;
                    text.hidden = composing;
                    const m = list.find((x) => x.id === select.value);
                    if (composing) {
                        meta.textContent = "To " + NAMES[other];
                    } else if (m) {
                        meta.textContent = (isView ? "From " : "To ") + NAMES[other] + " · " + stamp(m.at);
                        text.textContent = m.text;
                    } else {
                        meta.textContent = "";
                        text.textContent = isView ? "No messages yet." : "";
                    }
                }

                function send() {
                    const body = input.value.trim();
                    if (!body) return;
                    store.set(MESSAGES_PATH + "/" + newId(), { from: role, text: body.slice(0, MAX_LENGTH), at: now() });
                    input.value = "";
                    status.textContent = "Sent ✓";
                    setTimeout(() => { status.textContent = ""; }, 2500);
                }

                function close() {
                    document.removeEventListener("keydown", onKey);
                    overlay.remove();
                    if (openModal && openModal.overlay === overlay) openModal = null;
                }
                const onKey = (e) => { if (e.key === "Escape") close(); };

                select.addEventListener("change", () => { userPicked = true; render(items()); if (select.value === NEW) input.focus(); });
                sendBtn.addEventListener("click", send);
                input.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
                closeBtn.addEventListener("click", close);
                overlay.addEventListener("pointerdown", (e) => { if (e.target === overlay) close(); });
                document.addEventListener("keydown", onKey);

                openModal = { overlay, close, refresh };
                refresh();
                if (!isView) input.focus();
            }
        }
    };
})();
