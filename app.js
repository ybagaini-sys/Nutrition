(() => {
  const $ = (id) => document.getElementById(id);
  const cfg = window.FORME_CONFIG || {};
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  const configured = cfg.SUPABASE_URL?.startsWith("https://") &&
    cfg.SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_publishable_");

  const setup = $("setupNotice");
  const auth = $("authPanel");
  const dashboard = $("dashboard");
  const badge = $("connectionBadge");
  const msg = $("authMessage");

  if (!configured || !window.supabase) {
    setup.classList.remove("hidden");
    badge.textContent = "Configuration requise";
    return;
  }

  const client = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_PUBLISHABLE_KEY,
    { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }
  );

  function showAuth(message = "") {
    auth.classList.remove("hidden");
    dashboard.classList.add("hidden");
    msg.textContent = message;
  }

  async function showDashboard(session) {
    auth.classList.add("hidden");
    dashboard.classList.remove("hidden");
    badge.textContent = "Connecté";
    $("userLabel").textContent = session.user.email || "Compte personnel";

    const { data, error } = await client
      .from("profiles")
      .select("timezone, created_at")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (error) {
      $("profileStatus").textContent =
        "Connexion établie, mais lecture du profil refusée : " + error.message;
    } else if (data) {
      $("profileStatus").textContent =
        "Profil trouvé · Fuseau horaire : " + (data.timezone || "non défini");
    } else {
      $("profileStatus").textContent =
        "Connexion établie, mais aucun profil n'est associé à ce compte.";
    }
  }

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("loginForm").querySelector("button");
    button.disabled = true;
    button.textContent = "Connexion…";
    msg.textContent = "";
    const { data, error } = await client.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value
    });
    button.disabled = false;
    button.textContent = "Se connecter";
    if (error) {
      showAuth("Connexion impossible : " + error.message);
      return;
    }
    await showDashboard(data.session);
  });

  $("logoutButton").addEventListener("click", async () => {
    await client.auth.signOut();
    showAuth("Tu es déconnecté.");
    badge.textContent = "Déconnecté";
  });

  client.auth.onAuthStateChange((_event, session) => {
    if (session) showDashboard(session);
    else showAuth();
  });

  client.auth.getSession().then(({ data }) => {
    if (data.session) showDashboard(data.session);
    else showAuth();
  });
})();