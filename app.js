
const $ = id => document.getElementById(id);

const SUPABASE_URL = window.FORME_CONFIG?.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.FORME_CONFIG?.SUPABASE_PUBLISHABLE_KEY;
let client = null;
let currentUser = null;
let currentProfile = null;
let currentPeriod = 7;
let withingsRows = [];
let todayFoods = [];

const TARGET_WEIGHT = 72;
const TARGET_PROTEIN = 160;

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function showMessage(id, message, error = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("error", error);
}

function formatDate(value, options = {}) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("fr-CH", options).format(date);
}

function number(value, decimals = 1) {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  return Number.isFinite(n)
    ? n.toLocaleString("fr-CH", {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      })
    : "—";
}

function kg(value) {
  return value === null || value === undefined ? "—" : `${number(value)} kg`;
}

function pct(value) {
  return value === null || value === undefined ? "—" : `${number(value)} %`;
}

function getLocalDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getStartOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function getStartOfWeek() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  return d.toISOString();
}

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function setConnection(connected, label) {
  const badge = $("connectionBadge");
  if (!badge) return;
  badge.textContent = label;
  badge.classList.toggle("online", connected);
  badge.classList.toggle("offline", !connected);
}

function showDashboard(show) {
  $("authPanel")?.classList.toggle("hidden", show);
  $("dashboard")?.classList.toggle("hidden", !show);
}

async function init() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) {
    $("setupNotice")?.classList.remove("hidden");
    setConnection(false, "Configuration manquante");
    return;
  }

  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  $("loginForm")?.addEventListener("submit", login);
  $("logoutButton")?.addEventListener("click", logout);
  $("refreshButton")?.addEventListener("click", loadDashboard);
  $("weightForm")?.addEventListener("submit", saveManualWeight);
  $("foodForm")?.addEventListener("submit", saveFood);
  $("withingsConnect")?.addEventListener("click", connectWithings);
  $("withingsSync")?.addEventListener("click", syncWithings);

  document.querySelectorAll(".period-button").forEach(button => {
    button.addEventListener("click", () => {
      currentPeriod = Number(button.dataset.days);
      document.querySelectorAll(".period-button").forEach(b => {
        b.classList.toggle("active", b === button);
      });
      renderCharts();
    });
  });

  const { data, error } = await client.auth.getSession();
  if (error) {
    setConnection(false, "Erreur de connexion");
    showMessage("authMessage", error.message, true);
    return;
  }

  if (data.session) {
    currentUser = data.session.user;
    await loadDashboard();
  } else {
    showDashboard(false);
    setConnection(false, "Non connecté");
  }

  client.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user || null;
    if (currentUser) {
      await loadDashboard();
    } else {
      showDashboard(false);
      setConnection(false, "Non connecté");
    }
  });
}

async function login(event) {
  event.preventDefault();
  showMessage("authMessage", "Connexion en cours…");

  const email = $("email").value.trim();
  const password = $("password").value;

  const { data, error } = await client.auth.signInWithPassword({
    email,
    password
  });

  if (error) {
    showMessage("authMessage", error.message, true);
    return;
  }

  currentUser = data.user;
  showMessage("authMessage", "Connexion réussie.");
  await loadDashboard();
}

async function logout() {
  if (!client) return;
  await client.auth.signOut();
  currentUser = null;
  showDashboard(false);
  setConnection(false, "Non connecté");
}

async function loadDashboard() {
  if (!currentUser || !client) return;

  showDashboard(true);
  setConnection(true, "Connecté");
  setText("userLabel", currentUser.email || "Espace personnel");
  setText("todayLabel", formatDate(new Date(), {
    weekday: "long",
    day: "numeric",
    month: "long"
  }).toUpperCase());

  await Promise.all([
    loadProfile(),
    loadNutrition(),
    loadWorkouts(),
    loadWithings()
  ]);

  setText("syncStatus", `Dernière actualisation : ${formatDate(new Date(), {
    hour: "2-digit",
    minute: "2-digit"
  })}`);
}

async function loadProfile() {
  const { data, error } = await client
    .from("profiles")
    .select("*")
    .eq("user_id", currentUser.id)
    .maybeSingle();

  if (error) {
    console.error("Erreur profil", error);
    return;
  }

  currentProfile = data || {};

  const height = Number(currentProfile.height_cm || 178);
  const dob = currentProfile.date_of_birth || "1980-08-04";
  const birth = new Date(`${dob}T12:00:00`);
  let age = new Date().getFullYear() - birth.getFullYear();
  const monthDiff = new Date().getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && new Date().getDate() < birth.getDate())) age--;

  setText("ageValue", `${age} ans`);
  setText("heightValue", `${number(height, 0)} cm`);
  setText("targetValue", `${TARGET_WEIGHT} kg`);
  setText("weightGoal", `${TARGET_WEIGHT} kg`);
  setText("proteinTarget", `Objectif : ${TARGET_PROTEIN} g`);
}

async function loadNutrition() {
  const start = getStartOfToday();

  const { data, error } = await client
    .from("nutrition_logs")
    .select("*")
    .eq("user_id", currentUser.id)
    .gte("consumed_at", start)
    .order("consumed_at", { ascending: false });

  if (error) {
    console.error("Erreur nutrition", error);
    return;
  }

  todayFoods = data || [];
  renderNutrition();
}

function renderNutrition() {
  const calories = todayFoods.reduce((sum, item) => sum + Number(item.calories || 0), 0);
  const protein = todayFoods.reduce((sum, item) => sum + Number(item.protein_g || 0), 0);
  const calorieTarget = 2200;

  setText("caloriesValue", Math.round(calories).toLocaleString("fr-CH"));
  setText("proteinValue", `${number(protein, 0)} g`);
  setText("proteinMacro", `${number(protein, 0)} / ${TARGET_PROTEIN} g`);
  setText("calorieMacro", `${Math.round(calories)} / ${calorieTarget} kcal`);
  setText("calorieTarget", `Objectif provisoire : ${calorieTarget} kcal`);
  setText("targetCaloriesValue", `${calorieTarget} kcal`);
  setText("foodCount", `${todayFoods.length} entrée${todayFoods.length > 1 ? "s" : ""}`);

  const proteinBar = $("proteinBar");
  const calorieBar = $("calorieBar");
  if (proteinBar) proteinBar.style.width = `${Math.min(100, protein / TARGET_PROTEIN * 100)}%`;
  if (calorieBar) calorieBar.style.width = `${Math.min(100, calories / calorieTarget * 100)}%`;

  const history = $("foodHistory");
  if (!history) return;

  if (!todayFoods.length) {
    history.innerHTML = '<p class="muted">Aucune consommation enregistrée aujourd’hui.</p>';
    return;
  }

  history.innerHTML = todayFoods.map(item => `
    <div class="food-entry">
      <div class="food-info">
        <strong>${escapeHTML(item.food_name || item.name || "Aliment")}</strong>
        <small>${formatDate(item.consumed_at, { hour: "2-digit", minute: "2-digit" })} · ${Math.round(Number(item.calories || 0))} kcal · ${number(item.protein_g || 0)} g protéines</small>
      </div>
      <button class="delete-button" type="button" data-delete-food="${escapeHTML(item.id)}" aria-label="Supprimer">×</button>
    </div>
  `).join("");

  history.querySelectorAll("[data-delete-food]").forEach(button => {
    button.addEventListener("click", () => deleteFood(button.dataset.deleteFood));
  });
}

async function saveFood(event) {
  event.preventDefault();
  const button = $("foodForm").querySelector('button[type="submit"]');
  button.disabled = true;
  showMessage("foodMessage", "Enregistrement…");

  const row = {
    user_id: currentUser.id,
    food_name: $("foodName").value.trim(),
    calories: Number($("foodKcal").value),
    protein_g: Number($("foodProtein").value),
    carbs_g: Number($("foodCarbs").value || 0),
    fat_g: Number($("foodFat").value || 0),
    consumed_at: new Date().toISOString()
  };

  const { error } = await client.from("nutrition_logs").insert(row);
  button.disabled = false;

  if (error) {
    console.error(error);
    showMessage("foodMessage", `Erreur : ${error.message}`, true);
    return;
  }

  $("foodForm").reset();
  $("foodCarbs").value = "0";
  $("foodFat").value = "0";
  showMessage("foodMessage", "Aliment ajouté.");
  await loadNutrition();
}

async function deleteFood(id) {
  if (!confirm("Supprimer cette entrée alimentaire ?")) return;

  const { error } = await client
    .from("nutrition_logs")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);

  if (error) {
    alert(`Impossible de supprimer : ${error.message}`);
    return;
  }

  await loadNutrition();
}

async function loadWorkouts() {
  const start = getStartOfWeek();
  const { count, error } = await client
    .from("strength_workouts")
    .select("*", { count: "exact", head: true })
    .eq("user_id", currentUser.id)
    .gte("started_at", start);

  if (error) {
    console.error("Erreur séances", error);
    setText("workoutsValue", "—");
    return;
  }

  setText("workoutsValue", String(count || 0));
}

async function loadWithings() {
  setText("compositionDate", "Chargement…");

  const { data, error } = await client
    .from("body_measurements")
    .select("id,measured_at,source,weight_kg,body_fat_pct,fat_mass_kg,muscle_mass_kg,lean_mass_kg,water_pct,bone_mass_kg,visceral_fat_index")
    .eq("user_id", currentUser.id)
    .eq("source", "withings")
    .order("measured_at", { ascending: false })
    .limit(1000);

  if (error) {
    console.error("Erreur Withings", error);
    setText("compositionDate", "Erreur");
    setText("weightDate", "Impossible de charger les données Withings");
    return;
  }

  withingsRows = data || [];
  renderLatestWithings();
  renderCharts();
}

function renderLatestWithings() {
  const latest = withingsRows.find(row => row.weight_kg !== null && row.weight_kg !== undefined);

  if (!latest) {
    setText("weightValue", "—");
    setText("weightDate", "Aucune pesée Withings synchronisée");
    setText("compWeight", "—");
    setText("compositionDate", "Aucune donnée");
    setText("weightProgress", "Synchronise Withings pour afficher tes mesures.");
    return;
  }

  setText("weightValue", kg(latest.weight_kg));
  setText("weightDate", formatDate(latest.measured_at, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }));
  setText("compWeight", kg(latest.weight_kg));
  setText("compFatPct", pct(latest.body_fat_pct));
  setText("compFatKg", latest.fat_mass_kg == null ? "—" : kg(latest.fat_mass_kg));
  setText("compMuscle", kg(latest.muscle_mass_kg));
  setText("compLean", kg(latest.lean_mass_kg));
  setText("compBone", kg(latest.bone_mass_kg));
  setText("compVisceral", latest.visceral_fat_index == null ? "—" : number(latest.visceral_fat_index, 0));
  setText("compWater", pct(latest.water_pct));
  setText("compositionDate", formatDate(latest.measured_at, {
    day: "numeric",
    month: "short",
    year: "numeric"
  }));
  setText("weightProgress", `Écart avec ton objectif : ${number(Number(latest.weight_kg) - TARGET_WEIGHT)} kg`);
}

async function saveManualWeight(event) {
  event.preventDefault();
  const value = Number($("weightInput").value);

  if (!Number.isFinite(value) || value < 30 || value > 300) {
    showMessage("weightMessage", "Entre un poids valide.", true);
    return;
  }

  const { error } = await client.from("body_measurements").insert({
    user_id: currentUser.id,
    measured_at: new Date().toISOString(),
    source: "manual",
    external_id: `manual-${Date.now()}`,
    weight_kg: value
  });

  if (error) {
    showMessage("weightMessage", `Erreur : ${error.message}`, true);
    return;
  }

  $("weightForm").reset();
  showMessage("weightMessage", "Pesée manuelle enregistrée. Elle reste séparée de Withings.");
}

function renderCharts() {
  const cutoff = Date.now() - currentPeriod * 24 * 60 * 60 * 1000;
  const rows = withingsRows
    .filter(row => new Date(row.measured_at).getTime() >= cutoff)
    .sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));

  renderSingleChart("weightChart", rows, "weight_kg", "kg", "weightChange");
  renderSingleChart("fatChart", rows, "body_fat_pct", "%", "fatChange");
  renderSingleChart("muscleChart", rows, "muscle_mass_kg", "kg", "muscleChange");
}

function renderSingleChart(containerId, rows, key, unit, changeId) {
  const host = $(containerId);
  if (!host) return;

  const points = rows.filter(row => row[key] !== null && row[key] !== undefined && Number.isFinite(Number(row[key])));

  if (!points.length) {
    host.innerHTML = '<p class="muted">Pas encore assez de mesures Withings sur cette période.</p>';
    setText(changeId, "—");
    return;
  }

  const values = points.map(row => Number(row[key]));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, unit === "%" ? 0.5 : 0.3);
  const pad = range * 0.18;
  const low = min - pad;
  const high = max + pad;
  const width = 600;
  const height = 150;
  const left = 44;
  const right = 12;
  const top = 12;
  const bottom = 26;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const coords = points.map((row, index) => {
    const x = points.length === 1
      ? left + plotWidth / 2
      : left + index / (points.length - 1) * plotWidth;
    const y = top + (high - Number(row[key])) / (high - low) * plotHeight;
    return { x, y, row, value: Number(row[key]) };
  });

  const path = coords.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
  ).join(" ");

  const circles = coords.map(point =>
    `<circle cx="${point.x}" cy="${point.y}" r="3.5"><title>${number(point.value)} ${unit} · ${formatDate(point.row.measured_at, { day: "numeric", month: "short" })}</title></circle>`
  ).join("");

  const first = values[0];
  const last = values[values.length - 1];
  const difference = last - first;
  const sign = difference > 0 ? "+" : "";
  setText(changeId, `${sign}${number(difference)} ${unit}`);

  const startLabel = formatDate(points[0].measured_at, { day: "numeric", month: "short" });
  const endLabel = formatDate(points[points.length - 1].measured_at, { day: "numeric", month: "short" });

  host.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Évolution ${key}">
      <line class="chart-gridline" x1="${left}" y1="${top + plotHeight / 2}" x2="${width - right}" y2="${top + plotHeight / 2}"></line>
      <line class="chart-gridline" x1="${left}" y1="${top + plotHeight}" x2="${width - right}" y2="${top + plotHeight}"></line>
      <text class="chart-axis" x="2" y="${top + 4}">${number(high)}</text>
      <text class="chart-axis" x="2" y="${top + plotHeight}">${number(low)}</text>
      <path class="chart-line" d="${path}"></path>
      ${circles}
      <text class="chart-axis" x="${left}" y="${height - 4}">${startLabel}</text>
      <text class="chart-axis" text-anchor="end" x="${width - right}" y="${height - 4}">${endLabel}</text>
    </svg>
    <div class="chart-latest">${number(last)} ${unit} · ${points.length} mesure${points.length > 1 ? "s" : ""}</div>
  `;
}

async function connectWithings() {
  showMessage("withingsMessage", "Ouverture de la connexion Withings…");
  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData.session?.access_token;

  if (!token) {
    showMessage("withingsMessage", "Session expirée. Reconnecte-toi.", true);
    return;
  }

  const { data, error } = await client.functions.invoke("withings-connect", {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (error || !data?.url) {
    console.error(error, data);
    showMessage("withingsMessage", error?.message || "Impossible de démarrer la connexion.", true);
    return;
  }

  window.location.href = data.url;
}

async function syncWithings() {
  const button = $("withingsSync");
  button.disabled = true;
  showMessage("withingsMessage", "Synchronisation Withings en cours…");

  try {
    const { data: sessionData } = await client.auth.getSession();
    const token = sessionData.session?.access_token;

    if (!token) throw new Error("Session expirée. Reconnecte-toi.");

    const { data, error } = await client.functions.invoke("withings-sync", {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (error) throw error;

    showMessage("withingsMessage", data?.message || `${data?.imported ?? 0} mesure(s) synchronisée(s).`);
    await loadWithings();
  } catch (error) {
    console.error("Synchronisation Withings", error);
    showMessage("withingsMessage", error.message || "Erreur de synchronisation.", true);
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", init);
