"use strict";

/*
 * Pohjoisen Suomen onnettomuustiedotteet
 * GitHub Pages + GitHub Contents API: no backend and no database required.
 * IMPORTANT: client-side user/password is NOT secure authentication.
 * Actual write permission comes exclusively from the GitHub token entered by admin.
 */
(() => {
  const CONFIG = window.ONNETTOMUUS_APP;
  const DATA_FILE = CONFIG.dataPath || "tiedotteet.json";
  const SETTINGS_KEY = "pohtiedote-repo-v2";
  const SESSION_KEY = "pohtiedote-login-v2";
  const DRAFT_KEY = "pohtiedote-local-draft-v2";
  const FONT_KEY = "pohtiedote-textsize-v2";
  const SAVED_GITHUB_KEY = "pohtiedote-github-device-token-v1";
  // A saved token is OPTIONAL. Browser storage is not a secure vault.
  let restoreAttempted = false;
  const AREAS = [
    { id: "lappi", name: "Lapin pelastuslaitos" },
    { id: "pohjois-pohjanmaa", name: "Pohjois-Pohjanmaan pelastuslaitos" }
  ];
  const TYPES = ["Ensimmäinen mediatiedote", "Päivitystiedote", "Lopullinen mediatiedote"];
  const PHASES = ["Hälytetty", "Matkalla", "Kohteessa", "Toiminta käynnissä", "Toiminta päättynyt"];
  const $ = (sel, base = document) => base.querySelector(sel);
  const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
  const e = escapeHTML;
  const app = $("#app");
  const localSettings = parseJSON(localStorage.getItem(SETTINGS_KEY), {});
  const state = {
    notices: [], loaded: false, loadError: "",
    selectedArea: "all", search: "", pageSize: 12, page: 1,
    loggedUser: sessionStorage.getItem(SESSION_KEY) || "",
    token: "", connected: false,
    repo: { ...guessRepo(), ...localSettings },
    busy: false
  };

  function parseJSON(raw, fallback) {
    try { return JSON.parse(raw) ?? fallback; } catch { return fallback; }
  }
  function guessRepo() {
    const hostname = window.location.hostname;
    const hostMatch = hostname.match(/^([\w-]+)\.github\.io$/i);
    const segments = location.pathname.split("/").filter(Boolean);
    const repoSegment = segments[0] && segments[0] !== "index.html" ? segments[0] : "";
    return {
      owner: hostMatch ? hostMatch[1] : "",
      repo: repoSegment || (hostMatch ? `${hostMatch[1]}.github.io` : ""),
      branch: "main"
    };
  }
  function setHeading(title) { document.title = `${title} | Onnettomuustiedotteet`; }
  function fmt(value, dateOnly = false) {
    if (!value) return "–";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "–";
    const opts = { timeZone: "Europe/Helsinki", day: "2-digit", month: "2-digit", year: "numeric" };
    if (!dateOnly) Object.assign(opts, { hour: "2-digit", minute: "2-digit" });
    const fields = Object.fromEntries(new Intl.DateTimeFormat("fi-FI", opts)
      .formatToParts(date).filter(part => part.type !== "literal")
      .map(part => [part.type, part.value]));
    return `${fields.day}.${fields.month}.${fields.year}${dateOnly ? "" : ` ${fields.hour}:${fields.minute}`}`;
  }
  function datetimeInput(value) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return "";
    // Form values represent Finnish local time regardless of viewer's timezone.
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).format(d);
    return parts.replace(" ", "T");
  }
  function localFinlandISOString(value) {
    // datetime-local doesn't include timezone. Determine Finnish offset via Intl.
    if (!value) return "";
    const tentative = new Date(`${value}:00Z`);
    if (Number.isNaN(tentative.getTime())) return "";
    const offsetAt = (date) => {
      const seg = new Intl.DateTimeFormat("en-US", {
        timeZone: "Europe/Helsinki", timeZoneName: "shortOffset", hour: "2-digit"
      }).formatToParts(date).find(p => p.type === "timeZoneName")?.value || "GMT+2";
      const m = seg.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
      return m ? (m[1] === "+" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 120;
    };
    let date = new Date(tentative.getTime() - offsetAt(tentative) * 60000);
    date = new Date(tentative.getTime() - offsetAt(date) * 60000);
    return date.toISOString();
  }
  function sortNewest(a, b) {
    return new Date(b.incidentDate || b.publishedAt || 0) - new Date(a.incidentDate || a.publishedAt || 0);
  }
  function goodNotices(obj) {
    if (!obj || !Array.isArray(obj.notices)) throw new Error("Tiedotetiedoston sisältö ei ole kelvollinen.");
    return obj.notices.filter(n => n && typeof n === "object" && typeof n.id === "string");
  }
  function nameOfArea(id) { return AREAS.find(a => a.id === id)?.name || "–"; }
  function isPublished(n) { return n.status === "published"; }
  function hashPath() { return decodeURIComponent(location.hash.replace(/^#\/?/, "")).split("/").filter(Boolean); }
  function notify(message, isError = false) {
    const parent = $("#toast-container");
    const el = document.createElement("div");
    el.className = `toast${isError ? " error" : ""}`;
    el.textContent = message;
    parent.append(el);
    setTimeout(() => el.remove(), 5500);
  }
  function headerSync(section) {
    const link = $("#login-link");
    link.textContent = state.loggedUser ? "Ylläpito" : "Kirjaudu";
    link.href = state.loggedUser ? "#/admin" : "#/login";
    document.querySelectorAll(".header-nav a").forEach(a => {
      a.classList.toggle("active", a.dataset.nav === (section === "public" ? "public" : "login"));
    });
  }
  function anchorRoute() {
    const path = hashPath();
    if (path[0] === "tiedote" && path[1]) return showDetail(path[1]);
    if (path[0] === "login") return showLogin();
    if (path[0] === "admin") return showAdmin(path[1] || "overview", path[2]);
    showPublic();
  }
  async function loadPublic() {
    try {
      const response = await fetch(`${DATA_FILE}?v=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.text();
      if (!raw.trim()) throw new Error("tiedotteet.json on tyhjä");
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { throw new Error("tiedotteet.json ei ole kelvollista JSONia – korvaa se ladatulla tiedostolla"); }
      state.notices = goodNotices(parsed);
      state.loadError = "";
    } catch (err) {
      state.notices = [];
      state.loadError = `Tiedotteiden lataus epäonnistui: ${err.message}. Tarkista tiedosto tiedotteet.json GitHub-repositorion juuressa (samalla tasolla kuin index.html).`;
    }
    state.loaded = true;
    anchorRoute();
  }

  // --- Public list ----------------------------------------------------------
  function showPublic() {
    headerSync("public");
    setHeading("Julkinen tiedotelista");
    app.innerHTML = `
      <section class="public-list" aria-labelledby="list-title">
        <h1 class="page-heading" id="list-title">Valitse alue</h1>
        <div class="section-rule"></div>
        <div class="area-filter" role="group" aria-label="Rajaa alueen mukaan">
          <button type="button" class="btn ${state.selectedArea === "all" ? "btn-red" : "btn-slate"}" data-area="all" aria-pressed="${state.selectedArea === "all"}">Kaikki</button>
          ${AREAS.map(area => `<button type="button" class="btn ${state.selectedArea === area.id ? "btn-red" : "btn-slate"}" data-area="${area.id}" aria-pressed="${state.selectedArea === area.id}">${e(area.name)}</button>`).join("")}
        </div>
        <div class="filter-controls">
          <label class="page-size-control">Näytä kerralla
            <select id="page-size" aria-label="Tiedotteita sivulla">${[6,12,24,48].map(n => `<option value="${n}" ${state.pageSize === n ? "selected" : ""}>${n}</option>`).join("")}</select>
            riviä
          </label>
          <div class="filter-right">
            <div class="view-pill" title="Tiedotekortit" aria-hidden="true">≡</div>
            <label class="search-control">Etsi: <input type="search" id="notice-search" value="${e(state.search)}" autocomplete="off"></label>
          </div>
        </div>
        ${state.loadError ? `<div class="alert" role="alert">${e(state.loadError)}</div>` : ""}
        <div id="list-results"></div>
      </section>`;
    updatePublicList();
  }
  function filteredNotices() {
    const query = state.search.toLocaleLowerCase("fi-FI").trim();
    return state.notices.filter(n => isPublished(n) &&
      (state.selectedArea === "all" || n.organization === state.selectedArea) &&
      (!query || [n.title, n.taskType, n.municipality, n.locality, n.address, n.description, nameOfArea(n.organization)]
        .some(value => String(value || "").toLocaleLowerCase("fi-FI").includes(query)))).sort(sortNewest);
  }
  function updatePublicList() {
    const target = $("#list-results");
    if (!target) return;
    const notices = filteredNotices();
    const pages = Math.max(1, Math.ceil(notices.length / state.pageSize));
    state.page = Math.min(pages, Math.max(1, state.page));
    const shown = notices.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    const cards = shown.map(n => `
      <article class="notice-card">
        <dl class="notice-fields">
          <div class="notice-row"><dt>Otsikko</dt><dd class="notice-card-title">${e(n.title || "Nimetön tiedote")}</dd></div>
          <div class="notice-row"><dt>Päiväys</dt><dd>${e(fmt(n.incidentDate || n.publishedAt))}</dd></div>
          <div class="notice-row"><dt>Organisaatio</dt><dd>${e(nameOfArea(n.organization))}</dd></div>
          <div class="notice-row"><dt>Lisäyspäivä</dt><dd>${e(fmt(n.publishedAt))}</dd></div>
        </dl>
        <div class="notice-card-foot"><a class="btn btn-red btn-block" href="#/tiedote/${encodeURIComponent(n.id)}">Katsele</a></div>
      </article>`).join("");
    target.innerHTML = `
      <p class="status-line" role="status">${notices.length} ${notices.length === 1 ? "tiedote" : "tiedotetta"}${state.search ? " vastaa hakua" : ""}</p>
      ${shown.length ? `<div class="notice-grid">${cards}</div>` : `
        <div class="empty-state"><div class="empty-icon" aria-hidden="true">≡</div>
          <h3>Ei ${state.search ? "hakua vastaavia" : "julkaistuja"} tiedotteita</h3>
          <p>${state.search ? "Kokeile toista hakusanaa tai valitse kaikki alueet." : "Tälle alueelle ei ole vielä julkaistu onnettomuustiedotteita."}</p>
        </div>`}
      ${pages > 1 ? `<nav class="pager" aria-label="Sivutus">
        <button class="btn btn-quiet btn-sm" data-page="${state.page-1}" ${state.page === 1 ? "disabled" : ""}>Edellinen</button>
        <span class="pager-info">Sivu ${state.page} / ${pages}</span>
        <button class="btn btn-quiet btn-sm" data-page="${state.page+1}" ${state.page === pages ? "disabled" : ""}>Seuraava</button>
      </nav>` : ""}`;
  }
  function showDetail(id) {
    headerSync("public");
    const notice = state.notices.find(n => n.id === id && isPublished(n));
    if (!notice) {
      setHeading("Tiedotetta ei löydy");
      app.innerHTML = `<div class="empty-state"><h1>Tiedotetta ei löydy</h1><p>Tiedote on voitu poistaa, tai linkki on virheellinen.</p><p style="margin-top:24px"><a href="#/" class="btn btn-red">Takaisin listaan</a></p></div>`;
      return;
    }
    setHeading(notice.title);
    app.innerHTML = `
      <article class="detail-container">
        <h1 class="detail-title">${e(notice.type || TYPES[0])}: ${e(notice.title)}</h1>
        <div class="section-rule" style="margin-bottom:10px"></div>
        <div class="detail-date">JULKAISTU: ${e(fmt(notice.publishedAt))}</div>
        <p class="detail-updated">PÄIVITETTY VIIMEKSI: ${e(fmt(notice.updatedAt || notice.publishedAt))}</p>
        <dl class="detail-fields">
          <div class="detail-row"><dt>Tiedotteen tyyppi:</dt><dd>${e(notice.type || TYPES[0])}</dd></div>
          <div class="detail-row"><dt>Julkaiseva organisaatio:</dt><dd>${e(nameOfArea(notice.organization))}</dd></div>
          <div class="detail-row"><dt>Tapahtuman perustiedot:</dt><dd>
            <div class="fact-line"><strong>Tehtävälaji:</strong> ${e(notice.taskType || "–")}</div>
            <div class="fact-line"><strong>Tapahtumakunta tai -kaupunki:</strong> ${e(notice.municipality || "–")}</div>
            <div class="fact-line"><strong>Paikkakunta, asuinalue tai kylä:</strong> ${e(notice.locality || "–")}</div>
            <div class="fact-line"><strong>Tapahtumapaikka:</strong> ${e(notice.address || "–")}</div>
            <div class="fact-line"><strong>Tapahtuma-aika:</strong> ${e(fmt(notice.incidentDate))}</div>
            <div class="fact-line"><strong>Kesto:</strong> ${e(notice.duration || "–")}</div>
            <div class="fact-line"><strong>Vaihe:</strong> ${e(notice.phase || "–")}</div>
          </dd></div>
          <div class="detail-row"><dt>Osallisena olleiden henkilöiden lukumäärä:</dt><dd>${e(notice.persons || "Ei tiedossa")}${notice.persons ? " <span class=\"hint\">(Henkilövahinkotieto perustuu tapahtumapaikalla tehtyyn ensiarvioon.)</span>" : ""}</dd></div>
          <div class="detail-row"><dt>Tapahtuman kuvaus:</dt><dd class="description-body">${e(notice.description || "Ei lisätietoja.")}</dd></div>
        </dl>
        <div class="detail-actions"><a class="btn btn-red" href="#/">Takaisin listaan</a></div>
      </article>`;
  }

  // --- Login ---------------------------------------------------------------
  function showLogin() {
    headerSync("login");
    setHeading("Kirjaudu");
    if (state.loggedUser) { location.hash = "#/admin"; return; }
    app.innerHTML = `
      <div class="login-page"><section class="login-panel" aria-labelledby="login-title">
        <div class="login-emblem" aria-hidden="true">▥</div>
        <h1 id="login-title" class="login-title">Ylläpidon kirjautuminen</h1>
        <p class="login-subtitle">Lapin ja Pohjois-Pohjanmaan onnettomuustiedotteet</p>
        <form id="login-form" autocomplete="on">
          <div class="form-field"><label for="login-user">Käyttäjätunnus</label><input id="login-user" name="username" type="text" autocomplete="username" required autofocus placeholder="Käyttäjätunnus"></div>
          <div class="form-field"><label for="login-password">Salasana</label><input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Salasana"></div>
          <div id="login-error" class="alert" role="alert" hidden></div>
          <div class="login-actions"><a href="#/" class="btn btn-slate">Peruuta</a><button type="submit" class="btn btn-red">Kirjaudu sisään</button></div>
        </form>
        <p class="login-footnote">Ylläpitotunnus avaa tiedotteiden hallinnan. Julkaiseminen GitHubiin edellyttää lisäksi erillistä kirjoitusoikeutta.</p>
      </section></div>`;
  }
  function submitLogin(form) {
    const user = String(form.elements.username.value || "");
    const password = String(form.elements.password.value || "");
    const match = CONFIG.users.find(u => u.username === user && u.password === password);
    if (!match) {
      const el = $("#login-error"); el.hidden = false;
      el.textContent = "Käyttäjätunnus tai salasana on virheellinen.";
      return;
    }
    state.loggedUser = match.username;
    sessionStorage.setItem(SESSION_KEY, match.username);
    notify("Kirjautuminen onnistui.");
    restoreAttempted = false;
    location.hash = "#/admin";
  }
  function logout() {
    sessionStorage.removeItem(SESSION_KEY);
    state.loggedUser = "";
    state.token = "";
    state.connected = false;
    // Logout clears the active connection but not the opt-in remembered token.
    // "Katkaise yhteys" in settings removes the remembered token completely.
    notify("Olet kirjautunut ulos.");
    location.hash = "#/";
    anchorRoute();
  }

  // --- GitHub API ----------------------------------------------------------
  function apiURL() {
    const { owner, repo, branch } = state.repo;
    if (!/^[A-Za-z0-9-]+$/.test(owner || "") || !/^[\w.-]+$/.test(repo || "") || !branch || /[?#]/.test(branch)) {
      throw new Error("Tarkista GitHub-käyttäjänimi, repositorion nimi ja haara.");
    }
    return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeURIComponent(DATA_FILE)}?ref=${encodeURIComponent(branch)}`;
  }
  function apiHeaders() {
    if (!state.token) throw new Error("Yhdistä GitHub-tili ensin Asetuksissa.");
    return {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${state.token}`,
      "X-GitHub-Api-Version": "2022-11-28"
    };
  }
  function fromBase64(raw) {
    const binary = atob(raw.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let result = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      result += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(result);
  }
  async function githubGet() {
    const res = await fetch(apiURL(), { headers: apiHeaders(), cache: "no-store" });
    if (!res.ok) {
      let apiError = "";
      try { apiError = (await res.json()).message || ""; } catch {}
      throw new Error(res.status === 404
        ? "Tiedostoa ei löydy repositoriosta. Lisää tiedotteet.json ensin GitHubiin ja tarkista haara."
        : res.status === 401 || res.status === 403
          ? `GitHub esti pyynnön (${res.status}). Tarkista token ja sen Contents: Read and write -oikeus.`
          : `GitHub-virhe ${res.status}: ${apiError || "Yhteys epäonnistui."}`);
    }
    const content = await res.json();
    if (content.type !== "file" || !content.content) throw new Error("GitHub ei palauttanut tiedotetiedoston sisältöä.");
    let data;
    try { data = JSON.parse(fromBase64(content.content)); }
    catch { throw new Error("GitHubissa oleva tiedotteet.json on rikki. Korjaa se ennen yhdistämistä."); }
    goodNotices(data);
    return { data, sha: content.sha };
  }
  async function githubSave(transform, description) {
    if (state.busy) throw new Error("Tallennus on jo käynnissä.");
    state.busy = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        // Always re-read current file to avoid silently overwriting another editor's work.
        const { data, sha } = await githubGet();
        const next = transform(structuredClone(data));
        next.version = 1;
        next.updatedAt = new Date().toISOString();
        const url = apiURL().split("?ref=")[0];
        const response = await fetch(url, {
          method: "PUT",
          headers: { ...apiHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({
            message: `Tiedotejärjestelmä: ${description}`,
            content: toBase64(JSON.stringify(next, null, 2) + "\n"), sha,
            branch: state.repo.branch
          })
        });
        if (response.status === 409) continue;
        if (!response.ok) {
          let message = "";
          try { message = (await response.json()).message; } catch {}
          throw new Error(`GitHub-tallennus epäonnistui (${response.status}): ${message || "tuntematon virhe"}`);
        }
        state.notices = goodNotices(next);
        state.loaded = true;
        return next;
      }
      throw new Error("Tiedosto muuttui yhtä aikaa toisessa istunnossa. Kokeile uudelleen.");
    } finally { state.busy = false; }
  }
  function getSavedGitHub() {
    const saved = parseJSON(localStorage.getItem(SAVED_GITHUB_KEY), null);
    if (!saved || typeof saved.token !== "string" || !saved.token) return null;
    if (saved.owner !== state.repo.owner || saved.repo !== state.repo.repo || saved.branch !== state.repo.branch) return null;
    return saved;
  }

  async function restoreGitHub() {
    if (restoreAttempted || !state.loggedUser || state.connected || state.busy || state.token) return;
    restoreAttempted = true;
    const saved = getSavedGitHub();
    if (!saved) return;
    state.token = saved.token;
    try {
      // Check saved credentials on GitHub before claiming the connection works.
      const { data } = await githubGet();
      if (!state.loggedUser || state.token !== saved.token) return;
      state.notices = goodNotices(data);
      state.loaded = true;
      state.connected = true;
      const path = hashPath();
      if (path[0] === "admin") {
        if (!path[1] || path[1] === "overview" || path[1] === "settings") {
          showAdmin(path[1] || "overview", path[2] || "");
        } else {
          const indicator = $(".connected-info");
          if (indicator) {
            indicator.classList.add("is-connected");
            indicator.innerHTML = '<span class="dot"></span>GitHub-yhteys muodostettu';
          }
          $("[data-connection-hint]")?.remove();
        }
      }
    } catch (err) {
      if (state.token !== saved.token) return;
      state.token = "";
      state.connected = false;
      // Keep the saved token on temporary connection errors. A rejected token
      // must be entered again; do not repeatedly send a known invalid token.
      if (/GitHub esti pyynnön/.test(err.message)) {
        localStorage.removeItem(SAVED_GITHUB_KEY);
        notify("Tallennettu GitHub-token ei enää kelpaa. Luo uusi ja yhdistä uudelleen.", true);
      } else {
        notify(`Automaattinen GitHub-yhteys epäonnistui: ${err.message}`, true);
      }
    }
  }

  async function connectGitHub(form) {
    if (state.busy) return;
    const fields = form.elements;
    const enteredToken = String(fields.token.value || "").trim();
    const previous = { ...state.repo };
    const previousToken = state.token;
    state.repo = {
      owner: String(fields.owner.value).trim(),
      repo: String(fields.repo.value).trim(),
      branch: String(fields.branch.value).trim() || "main"
    };
    state.token = enteredToken || state.token;
    try {
      const { data } = await githubGet();
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.repo));
      if (fields.remember.checked) {
        localStorage.setItem(SAVED_GITHUB_KEY, JSON.stringify({
          token: state.token, owner: state.repo.owner, repo: state.repo.repo, branch: state.repo.branch
        }));
      } else {
        localStorage.removeItem(SAVED_GITHUB_KEY);
      }
      state.notices = goodNotices(data);
      state.connected = true;
      state.loaded = true;
      notify("Yhteys GitHubiin onnistui. Julkaisut tallennetaan nyt repositorioon.");
      showAdmin("settings");
    } catch (err) {
      state.connected = false;
      state.repo = previous;
      state.token = previousToken;
      notify(err.message, true);
      const msg = $("#settings-error");
      if (msg) { msg.hidden = false; msg.textContent = err.message; }
    }
  }

  // --- Administration ------------------------------------------------------
  function showAdmin(section = "overview", id = "") {
    if (!state.loggedUser) { location.hash = "#/login"; return; }
    headerSync("login");
    const pretty = ({ overview: "Hallintapaneeli", new: "Uusi tiedote", edit: "Muokkaa tiedotetta", settings: "GitHub-yhteys" })[section] || "Hallintapaneeli";
    setHeading(pretty);
    app.innerHTML = `
      <div class="admin-heading">
        <div><span class="admin-eyebrow">Ylläpito</span><h1>${e(pretty)}</h1><p>Pohjoisen Suomen onnettomuustiedotteiden hallinta</p></div>
        <div class="connected-info ${state.connected ? "is-connected" : ""}"><span class="dot"></span>${state.connected ? "GitHub-yhteys muodostettu" : "GitHub-yhteyttä ei ole muodostettu"}</div>
      </div>
      <div class="admin-shell">
        <aside class="admin-sidebar" aria-label="Ylläpidon valikko">
          <a href="#/admin" class="${section === "overview" ? "active" : ""}"><span aria-hidden="true">▤</span> Tiedotteet</a>
          <a href="#/admin/new" class="${section === "new" || section === "edit" ? "active" : ""}"><span aria-hidden="true">＋</span> Luo tiedote</a>
          <a href="#/admin/settings" class="${section === "settings" ? "active" : ""}"><span aria-hidden="true">⚙</span> GitHub-yhteys</a>
          <div class="admin-side-bottom"><a href="#/" aria-label="Julkinen tiedotelista">Julkinen sivu ↗</a><a href="#/" data-logout="true">Kirjaudu ulos</a></div>
        </aside>
        <div class="admin-content" id="admin-content"></div>
      </div>`;
    if (section === "settings") renderSettings();
    else if (section === "new") renderEditor();
    else if (section === "edit") renderEditor(id);
    else renderOverview();
    // Reconnect after returning to this page or logging in again.
    void restoreGitHub();
  }
  function connectionHint() {
    return state.connected ? "" : `<div class="alert alert-info" data-connection-hint="true"><strong>Julkaiseminen ei ole vielä käytössä.</strong> Yhdistä GitHub-repositorio ja syötä kirjoitusoikeuden token kohdassa <a href="#/admin/settings">GitHub-yhteys</a>. Voit silti kirjoittaa paikallisen luonnoksen.</div>`;
  }
  function renderOverview() {
    const out = $("#admin-content");
    const list = state.notices.filter(isPublished).sort(sortNewest);
    const lap = list.filter(n => n.organization === "lappi").length;
    const poh = list.filter(n => n.organization === "pohjois-pohjanmaa").length;
    const draft = parseJSON(localStorage.getItem(DRAFT_KEY), null);
    out.innerHTML = `
      ${connectionHint()}
      <div class="stats">
        <div class="stat-card"><span class="number">${list.length}</span><span class="stat-label">Julkaistua tiedotetta</span></div>
        <div class="stat-card"><span class="number">${lap}</span><span class="stat-label">Lappi</span></div>
        <div class="stat-card"><span class="number">${poh}</span><span class="stat-label">Pohjois-Pohjanmaa</span></div>
      </div>
      ${draft && draft.title ? `<div class="alert alert-info"><strong>Paikallinen luonnos:</strong> ${e(draft.title)}. <a href="#/admin/new">Avaa tiedote-editori</a>. Luonnosta ei ole julkaistu verkkoon.</div>` : ""}
      <section class="panel">
        <div class="panel-header"><div><h2 class="panel-title">Julkaistut tiedotteet</h2><p>Muokkaa, tarkastele tai poista tiedotteita.</p></div><a href="#/admin/new" class="btn btn-red btn-sm">＋ Uusi tiedote</a></div>
        ${list.length ? `<div class="admin-table-wrap"><table class="admin-table">
          <thead><tr><th>Otsikko</th><th>Alue</th><th>Julkaistu</th><th>Tila</th><th>Toiminnot</th></tr></thead>
          <tbody>${list.map(n => `<tr>
            <td><a href="#/tiedote/${encodeURIComponent(n.id)}">${e(n.title)}</a></td>
            <td>${e(nameOfArea(n.organization))}</td><td>${e(fmt(n.publishedAt))}</td>
            <td><span class="tag">Julkaistu</span></td>
            <td class="admin-table-actions"><a class="text-link" href="#/admin/edit/${encodeURIComponent(n.id)}">Muokkaa</a><button class="text-link danger" type="button" data-delete="${e(n.id)}">Poista</button></td>
          </tr>`).join("")}</tbody></table></div>` : `<div class="panel-body"><p class="hint">Tiedotteita ei vielä ole. Aloita luomalla ensimmäinen tiedote.</p></div>`}
      </section>`;
  }
  function renderSettings() {
    $("#admin-content").innerHTML = `
      <section class="panel"><div class="panel-header"><div><h2 class="panel-title">GitHub-tallennuksen asetukset</h2><p>Julkaisut tallennetaan tiedotteet.json-tiedostoon GitHubissa.</p></div></div>
        <div class="panel-body">
          <div class="helper-box"><strong>Miten tallennus toimii?</strong><p>Kirjoittaminen tallentaa muutoksen GitHub-repositorion tiedostoon. Julkiselle sivustolle muutokset tulevat näkyviin Pages-julkaisun päivityttyä.</p></div>
          <form id="settings-form">
            <div class="settings-grid">
              <div class="form-field"><label for="gh-owner">GitHub-käyttäjä / organisaatio</label><input id="gh-owner" name="owner" value="${e(state.repo.owner)}" placeholder="esim. oma-kayttaja" required></div>
              <div class="form-field"><label for="gh-repo">Repositorio</label><input id="gh-repo" name="repo" value="${e(state.repo.repo)}" placeholder="esim. onnettomuustiedotteet" required></div>
              <div class="form-field"><label for="gh-branch">Haara</label><input id="gh-branch" name="branch" value="${e(state.repo.branch)}" required><small>Useimmiten main.</small></div>
              <div class="form-field wide"><label for="gh-token">GitHub fine-grained token</label><input id="gh-token" name="token" type="password" placeholder="${state.token ? "Token käytössä (voit jättää tyhjäksi)" : "github_pat_..."}" autocomplete="off" ${state.token ? "" : "required"}>
                <small>Valitse GitHubissa vain tämä repositorio ja <strong>Contents → Read and write</strong>. Älä julkaise tokenia missään.</small></div>
              <div class="form-field wide" style="margin-top:-5px">
                <label for="gh-remember" style="display:flex;align-items:center;gap:9px;cursor:pointer;font-weight:500">
                  <input id="gh-remember" name="remember" type="checkbox" style="width:auto;margin:0" ${getSavedGitHub() ? "checked" : ""}>
                  Muista GitHub-token tällä laitteella
                </label>
                <small>Jos valitset tämän, token tallentuu tähän selaimeen ilman salausta ja yhteys muodostetaan automaattisesti jatkossa. Käytä vain omalla, luotetulla laitteella. Jaetulla koneella jätä valitsematta.</small>
              </div>
            </div>
            <p id="settings-error" class="alert" role="alert" hidden></p>
            <div class="inline-actions"><button class="btn btn-red" type="submit">Yhdistä GitHubiin</button><button class="btn btn-quiet" data-disconnect="true" type="button">Katkaise yhteys</button></div>
          </form>
          <div class="warning"><strong>Tietoturva:</strong> tämän staattisen sivuston käyttäjätunnus ja salasana näkyvät lähdekoodissa. Vain GitHubin oma token antaa todellisen oikeuden tallentaa muutoksia. Älä koskaan lisää tokenia index.html-tiedostoon.</div>
        </div>
      </section>`;
  }
  function field(name, label, value = "", options = {}) {
    const id = `editor-${name}`;
    const req = options.required ? ` required` : "";
    const requiredLabel = options.required ? ` <span class="required">*</span>` : "";
    const wide = options.wide ? " wide" : "";
    const placeholder = options.placeholder ? ` placeholder="${e(options.placeholder)}"` : "";
    const help = options.help ? `<small>${e(options.help)}</small>` : "";
    let control = "";
    if (options.choices) {
      control = `<select id="${id}" name="${name}"${req}>
        ${options.choices.map(opt => {
          const val = typeof opt === "object" ? opt.value : opt;
          const text = typeof opt === "object" ? opt.label : opt;
          return `<option value="${e(val)}" ${String(value) === String(val) ? "selected" : ""}>${e(text)}</option>`;
        }).join("")}</select>`;
    } else if (options.textarea) {
      control = `<textarea id="${id}" name="${name}" rows="8"${req}${placeholder}>${e(value)}</textarea>`;
    } else {
      control = `<input type="${options.type || "text"}" id="${id}" name="${name}" value="${e(value)}" ${req}${placeholder}${options.type === "number" ? ' min="0" step="1"' : ""}>`;
    }
    return `<div class="form-field${wide}"><label for="${id}">${e(label)}${requiredLabel}</label>${control}${help}</div>`;
  }
  function renderEditor(id = "") {
    const existing = id ? state.notices.find(n => n.id === id && isPublished(n)) : null;
    if (id && !existing) { $("#admin-content").innerHTML = `<div class="alert">Tiedotetta ei löydy. <a href="#/admin">Takaisin hallintaan</a>.</div>`; return; }
    const draft = !id ? parseJSON(localStorage.getItem(DRAFT_KEY), null) : null;
    const data = existing || draft || {};
    const org = data.organization || "pohjois-pohjanmaa";
    const incidentTime = datetimeInput(data.incidentDate || new Date().toISOString());
    $("#admin-content").innerHTML = `
      ${connectionHint()}
      <section class="panel">
        <div class="panel-header"><div><h2 class="panel-title">${id ? "Muokkaa julkaistua tiedotetta" : "Uusi onnettomuustiedote"}</h2><p>Tähdellä merkityt kentät ovat pakollisia.</p></div></div>
        <div class="panel-body">
          <form id="editor-form" data-edit-id="${e(id)}">
            <div class="editor-grid">
              ${field("organization", "Julkaiseva organisaatio", org, { choices: AREAS.map(a => ({value:a.id, label:a.name})), required:true })}
              ${field("type", "Tiedotteen tyyppi", data.type || TYPES[0], { choices: TYPES, required: true })}
              ${field("title", "Otsikko", data.title, { required:true, wide:true, placeholder:"Esim. Liikenneonnettomuus Rovaniemellä" })}
              ${field("incidentDate", "Tapahtuman ajankohta", incidentTime, { type:"datetime-local", required:true })}
              ${field("taskType", "Tehtävälaji", data.taskType, { placeholder:"Esim. Tieliikenneonnettomuus: keskisuuri" })}
              ${field("municipality", "Tapahtumakunta tai -kaupunki", data.municipality, { required:true, placeholder:"Esim. Rovaniemi" })}
              ${field("locality", "Paikkakunta, asuinalue tai kylä", data.locality, { placeholder:"Esim. Saarenkylä" })}
              ${field("address", "Tapahtumapaikka (tie, katu tai alue)", data.address, { placeholder:"Esim. Nelostie" })}
              ${field("duration", "Kesto", data.duration, { placeholder:"Esim. 1 tunti 30 minuuttia" })}
              ${field("phase", "Toiminnan vaihe", data.phase || PHASES[3], { choices: PHASES })}
              ${field("persons", "Osallisena olleiden henkilöiden lukumäärä", data.persons, { type:"number", placeholder:"Esim. 2" })}
              <div class="wide subsection-title">Tiedotteen sisältö</div>
              ${field("description", "Tapahtuman kuvaus", data.description, { textarea:true, required:true, wide:true, placeholder:"Kirjoita tapahtumakuvaus. Huomioi tiedotettavien tietojen luotettavuus sekä yksityisyydensuoja." })}
            </div>
            <div class="helper-box">Julkiselle sivulle näytetään vain julkaistut tiedotteet. Keskeneräinen teksti tallentuu automaattisesti tähän selaimeen, mutta ei GitHubiin ennen julkaisua.</div>
            <div class="editor-actions">
              <a href="#/admin" class="btn btn-quiet">Peruuta</a>
              <button type="button" class="btn btn-slate" data-save-draft="true">Tallenna luonnos selaimeen</button>
              <button type="submit" class="btn btn-red" id="publish-button">${id ? "Tallenna muutokset" : "Julkaise tiedote"}</button>
            </div>
          </form>
        </div>
      </section>`;
  }
  function readEditor(form) {
    const f = form.elements;
    return {
      organization: String(f.organization.value), type: String(f.type.value),
      title: String(f.title.value).trim(), incidentDate: localFinlandISOString(f.incidentDate.value),
      taskType: String(f.taskType.value).trim(), municipality: String(f.municipality.value).trim(),
      locality: String(f.locality.value).trim(), address: String(f.address.value).trim(),
      duration: String(f.duration.value).trim(), phase: String(f.phase.value),
      persons: String(f.persons.value).trim(), description: String(f.description.value).trim()
    };
  }
  function saveDraft() {
    const form = $("#editor-form");
    if (!form) return;
    localStorage.setItem(DRAFT_KEY, JSON.stringify(readEditor(form)));
    notify("Luonnos tallennettu tähän selaimeen. Sitä ei ole julkaistu.");
  }
  async function publish(form) {
    if (!form.reportValidity()) return;
    if (!state.connected || !state.token) {
      saveDraft();
      notify("Julkaiseminen vaatii GitHub-yhteyden. Siirry GitHub-yhteys-asetuksiin.", true);
      return;
    }
    const fields = readEditor(form);
    if (!AREAS.some(a => a.id === fields.organization)) { notify("Valitse oikea organisaatio.", true); return; }
    if (!fields.incidentDate) { notify("Tarkista tapahtuman ajankohta.", true); return; }
    const id = form.dataset.editId || (crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const button = $("#publish-button");
    button.disabled = true;
    button.textContent = "Tallennetaan GitHubiin…";
    try {
      const now = new Date().toISOString();
      await githubSave(data => {
        const idx = data.notices.findIndex(n => n.id === id);
        if (form.dataset.editId && idx === -1) throw new Error("Tiedote on poistettu toisen käyttäjän toimesta.");
        const original = idx === -1 ? {} : data.notices[idx];
        const updated = {
          ...original, ...fields, id,
          status: "published",
          publishedAt: original.publishedAt || now,
          updatedAt: now
        };
        if (idx === -1) data.notices.push(updated); else data.notices[idx] = updated;
        return data;
      }, `${form.dataset.editId ? "Päivitetty" : "Julkaistu"} ${fields.title}`);
      localStorage.removeItem(DRAFT_KEY);
      notify("Tiedote tallennettiin GitHubiin. Julkinen GitHub Pages -sivu päivittyy käyttöönotetun julkaisutavan mukaisesti.");
      location.hash = `#/tiedote/${encodeURIComponent(id)}`;
      anchorRoute();
    } catch (err) {
      saveDraft();
      notify(err.message, true);
    } finally {
      button.disabled = false;
      button.textContent = form.dataset.editId ? "Tallenna muutokset" : "Julkaise tiedote";
    }
  }
  async function removeNotice(id) {
    const n = state.notices.find(item => item.id === id);
    if (!n) return;
    if (!state.connected) { notify("Yhdistä GitHub ennen tiedotteen poistamista.", true); return; }
    if (!confirm(`Poistetaanko tiedote ”${n.title}”? Tiedote poistuu julkisesta listasta, mutta GitHubin versiohistoria säilyy.`)) return;
    try {
      await githubSave(data => {
        data.notices = data.notices.filter(item => item.id !== id);
        return data;
      }, `Poistettu ${n.title}`);
      notify("Tiedote poistettiin GitHubista.");
      showAdmin("overview");
    } catch (err) { notify(err.message, true); }
  }

  // --- Delegated events ----------------------------------------------------
  document.addEventListener("click", event => {
    const target = event.target;
    const area = target.closest("[data-area]");
    if (area) { state.selectedArea = area.dataset.area; state.page = 1; showPublic(); return; }
    const page = target.closest("[data-page]");
    if (page) { state.page = Number(page.dataset.page); updatePublicList(); return; }
    const font = target.closest("[data-font]");
    if (font) {
      const size = ({ small: ".92", medium: "1", large: "1.13" })[font.dataset.font] || "1";
      document.documentElement.style.setProperty("--text-scale", size);
      localStorage.setItem(FONT_KEY, size);
      return;
    }
    if (target.closest("[data-logout]")) { event.preventDefault(); logout(); return; }
    if (target.closest("[data-save-draft]")) { saveDraft(); return; }
    const remove = target.closest("[data-delete]");
    if (remove) { removeNotice(remove.dataset.delete); return; }
    if (target.closest("[data-disconnect]")) {
      localStorage.removeItem(SAVED_GITHUB_KEY);
      state.token = ""; state.connected = false;
      restoreAttempted = true;
      notify("GitHub-yhteys katkaistu ja mahdollisesti tallennettu token poistettu tältä selaimelta.");
      showAdmin("settings");
    }
  });
  document.addEventListener("change", event => {
    if (event.target.id === "page-size") {
      state.pageSize = Number(event.target.value) || 12;
      state.page = 1;
      updatePublicList();
    }
    if (event.target.closest("#editor-form")) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(readEditor($("#editor-form"))));
    }
  });
  document.addEventListener("input", event => {
    if (event.target.id === "notice-search") {
      state.search = event.target.value;
      state.page = 1;
      updatePublicList();
    }
    if (event.target.closest("#editor-form")) {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(readEditor($("#editor-form"))));
    }
  });
  document.addEventListener("submit", event => {
    if (event.target.id === "login-form") { event.preventDefault(); submitLogin(event.target); }
    if (event.target.id === "settings-form") { event.preventDefault(); connectGitHub(event.target); }
    if (event.target.id === "editor-form") { event.preventDefault(); publish(event.target); }
  });
  window.addEventListener("hashchange", () => {
    anchorRoute();
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  document.documentElement.style.setProperty("--text-scale", localStorage.getItem(FONT_KEY) || "1");
  loadPublic();
})();
