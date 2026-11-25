(() => {
  "use strict";

  const form = document.querySelector("#join-form");
  const name = document.querySelector("#guest-name");
  const section = document.querySelector("#guest-section");
  const message = document.querySelector("#join-message");
  const copy = document.querySelector("#join-copy");
  const SESSION_KEY = "webglow.guest-session";
  const PROFILE_KEY = "webglow.guest-profile";

  async function getRegistrationStatus() {
    const response = await fetch("/api/v1/guest-registration", { cache: "no-store" });
    const status = await response.json();
    section.replaceChildren(new Option("Choose your section", ""));
    (status.seatSections || ["Left", "Center", "Right"]).forEach((label) => section.append(new Option(label, label)));
    try {
      const profile = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
      if (profile && typeof profile.name === "string") name.value = profile.name;
      if (profile && typeof profile.section === "string" && [...section.options].some((item) => item.value === profile.section)) section.value = profile.section;
    } catch {}
    return status;
  }

  async function resumeSavedLight(status) {
    let token = "";
    try { token = localStorage.getItem(SESSION_KEY) || ""; } catch {}
    if (!token) return false;
    try {
      const response = await fetch("/api/v1/guest-registration", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ resumeToken: token }),
      });
      const body = await response.json().catch(() => undefined);
      if (response.ok && body?.displayPath) {
        window.location.replace(body.displayPath);
        return true;
      }
      if (response.status === 410) {
        await fetch("/api/v1/guest-registration/leave", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ resumeToken: token }),
        }).catch(() => undefined);
        try { localStorage.removeItem(SESSION_KEY); } catch {}
      } else if (!status.enabled && response.status === 403) {
        form.hidden = true;
        copy.textContent = "Guest registration is currently closed. Please ask the host to open it.";
        return true;
      } else if (!response.ok) {
        message.textContent = "Could not reconnect just now. Check your connection and try again.";
        return true;
      }
    } catch {
      message.textContent = "Could not reconnect just now. Check your connection and try again.";
      return true;
    }
    return false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    const submit = form.querySelector("button");
    submit.disabled = true;
    try {
      const profile = { name: name.value.trim(), section: section.value };
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch {}
      const response = await fetch("/api/v1/guest-registration", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ ...profile, keepAwake: true }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(response.status >= 500 ? "The service could not complete registration. Please try again." : body?.error?.message || "Unable to register this light.");
      if (body.guestSessionToken) try { localStorage.setItem(SESSION_KEY, body.guestSessionToken); } catch {}
      window.location.replace(body.displayPath);
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : "Unable to register this light.";
      submit.disabled = false;
    }
  });

  (async () => {
    const status = await getRegistrationStatus();
    if (await resumeSavedLight(status)) return;
    if (!status.enabled) {
      form.hidden = true;
      copy.textContent = "Guest registration is currently closed. Please ask the host to open it.";
    }
  })().catch(() => {
    form.hidden = true;
    copy.textContent = "The registration service is not available right now.";
  });
})();
