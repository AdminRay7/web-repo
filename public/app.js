const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// Load bot metadata
(async () => {
  try {
    const data = await api("/api");
    $("bot-name").textContent = data.bot || "303-XMD";
    $("bot-meta").textContent =
      `v${data.version} · ${data.sessions}/${data.capacity} sessions · ${data.commands} commands`;
  } catch {
    $("bot-meta").textContent = "bot unreachable";
  }
})();

// Pair
$("pair-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("pair-out").textContent = "pairing…";
  try {
    const body = {
      phone: $("phone").value.trim(),
      botName: $("botName").value.trim() || undefined,
      apiKey: $("apiKey").value.trim() || undefined,
    };
    const data = await api("/pair", {
      method: "POST",
      body: JSON.stringify(body),
    });
    $("pair-out").textContent =
      `✅ Session: ${data.sessionId}\n🔑 Code:    ${data.code}\n\n` +
      `Open WhatsApp → Linked Devices → Link with phone number.`;
  } catch (err) {
    $("pair-out").textContent = `❌ ${err.message}`;
  }
});

// Status
$("status-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = $("sid").value.trim();
  if (!sid) return;
  $("status-out").textContent = "checking…";
  try {
    const data = await api(`/status/${encodeURIComponent(sid)}`);
    $("status-out").textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $("status-out").textContent = `❌ ${err.message}`;
  }
});
