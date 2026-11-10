(() => {
  "use strict";

  const form = document.querySelector("#join-form");
  const name = document.querySelector("#guest-name");
  const message = document.querySelector("#join-message");
  const copy = document.querySelector("#join-copy");

  async function registrationStatus() {
    const response = await fetch("/api/v1/guest-registration", { cache: "no-store" });
    const status = await response.json();
    if (!status.enabled) {
      form.hidden = true;
      copy.textContent = "Guest registration is currently closed. Please ask the host to open it.";
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    message.textContent = "";
    const submit = form.querySelector("button");
    submit.disabled = true;
    try {
      const response = await fetch("/api/v1/guest-registration", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ name: name.value.trim() }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(body?.error?.message || "Unable to register this light.");
      window.location.replace(body.displayPath);
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : "Unable to register this light.";
      submit.disabled = false;
    }
  });

  registrationStatus().catch(() => {
    form.hidden = true;
    copy.textContent = "The registration service is not available right now.";
  });
})();
