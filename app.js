
const $ = id => document.getElementById(id);

const SUPABASE_URL = window.FORME_CONFIG?.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.FORME_CONFIG?.SUPABASE_PUBLISHABLE_KEY;

const TARGET_WEIGHT = 72;
const TARGET_PROTEIN = 160;
const CALORIE_TARGET = 2200;

let client = null;
let currentUser = null;
let currentProfile = null;
let currentPeriod = 7;
let withingsRows = [];
let todayFoods = [];
let libraryProducts = [];

let scannerReader = null;
let scannerControls = null;
let scannedProductData = null;
let scannerBusy = false;
let scanDetected = false;

/* =====================================================
   OUTILS GÉNÉRAUX
===================================================== */

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
  return value === null || value === undefined
    ? "—"
    : `${number(value)} kg`;
}

function pct(value) {
  return value === null || value === undefined
    ? "—"
    : `${number(value)} %`;
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

/* =====================================================
   INITIALISATION
===================================================== */

async function init() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !window.supabase) {
    $("setupNotice")?.classList.remove("hidden");
    setConnection(false, "Configuration manquante");
    return;
  }

  client = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
  );

  $("loginForm")?.addEventListener("submit", login);
  $("logoutButton")?.addEventListener("click", logout);
  $("refreshButton")?.addEventListener("click", loadDashboard);
  $("weightForm")?.addEventListener("submit", saveManualWeight);
  $("foodForm")?.addEventListener("submit", saveFood);
  $("foodQuantityUnit")?.addEventListener("change", updateFoodUnitLabels);
  $("scanQuantityUnit")?.addEventListener("change", () => {
    updateScanUnitLabels();
    updateScanPreview();
  });
  updateFoodUnitLabels();
  updateScanUnitLabels();

  $("withingsConnect")?.addEventListener("click", connectWithings);
  $("withingsSync")?.addEventListener("click", syncWithings);

  $("startScanner")?.addEventListener("click", startScanner);
  $("stopScanner")?.addEventListener("click", stopScanner);
  $("addScannedProduct")?.addEventListener("click", addScannedProduct);
  $("cancelScannedProduct")?.addEventListener("click", cancelScannedProduct);
  $("saveScannedToLibrary")?.addEventListener("click", saveScannedToLibrary);
  $("librarySearch")?.addEventListener("input", renderFoodLibrary);

  $("menuToggle")?.addEventListener("click", () => {
    const menu = $("mainMenu");
    const button = $("menuToggle");
    const isOpen = !menu?.classList.contains("hidden");
    menu?.classList.toggle("hidden", isOpen);
    button?.setAttribute("aria-expanded", String(!isOpen));
  });

  [
    "scanCalories",
    "scanProtein",
    "scanCarbs",
    "scanFat",
    "scanQuantity",
    "scanQuantityUnit",
    "scanNutritionBasis",
    "scanPieceWeight"
  ].forEach(id => {
    $(id)?.addEventListener("input", updateScanPreview);
  });

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
      await stopScanner();
      showDashboard(false);
      setConnection(false, "Non connecté");
    }
  });
}

/* =====================================================
   AUTHENTIFICATION
===================================================== */

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

  await stopScanner();
  await client.auth.signOut();

  currentUser = null;
  showDashboard(false);
  setConnection(false, "Non connecté");
}

/* =====================================================
   TABLEAU DE BORD
===================================================== */

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
    loadFoodLibrary(),
    loadWorkouts(),
    loadWithings()
  ]);

  setText("syncStatus", `Dernière actualisation : ${formatDate(new Date(), {
    hour: "2-digit",
    minute: "2-digit"
  })}`);
}

/* =====================================================
   PROFIL
===================================================== */

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
  const dob = currentProfile.birth_date || "1980-08-04";
  const birth = new Date(`${dob}T12:00:00`);

  let age = new Date().getFullYear() - birth.getFullYear();
  const monthDiff = new Date().getMonth() - birth.getMonth();

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && new Date().getDate() < birth.getDate())
  ) {
    age--;
  }

  setText("ageValue", `${age} ans`);
  setText("heightValue", `${number(height, 0)} cm`);
  setText("targetValue", `${TARGET_WEIGHT} kg`);
  setText("weightGoal", `${TARGET_WEIGHT} kg`);
  setText("proteinTarget", `Objectif : ${TARGET_PROTEIN} g`);
  setText("targetCaloriesValue", `${CALORIE_TARGET} kcal`);
}

/* =====================================================
   NUTRITION : CHARGEMENT
===================================================== */

async function loadNutrition() {
  const { data, error } = await client
    .from("nutrition_logs")
    .select("*")
    .eq("user_id", currentUser.id)
    .gte("consumed_at", getStartOfToday())
    .order("consumed_at", { ascending: false });

  if (error) {
    console.error("Erreur nutrition", error);

    showMessage(
      "scanSaveMessage",
      `Erreur de chargement : ${error.message}`,
      true
    );

    return false;
  }

  todayFoods = data || [];
  renderNutrition();

  return true;
}

/* =====================================================
   NUTRITION : AFFICHAGE ET HISTORIQUE
===================================================== */

function renderNutrition() {
  const calories = todayFoods.reduce(
    (sum, item) => sum + Number(item.kcal || 0),
    0
  );

  const protein = todayFoods.reduce(
    (sum, item) => sum + Number(item.protein_g || 0),
    0
  );

  const carbs = todayFoods.reduce(
    (sum, item) => sum + Number(item.carbs_g || 0),
    0
  );

  const fat = todayFoods.reduce(
    (sum, item) => sum + Number(item.fat_g || 0),
    0
  );

  setText("caloriesValue", number(calories, 0));
  setText("proteinValue", `${number(protein)} g`);
  setText("calorieTarget", `Objectif : ${CALORIE_TARGET} kcal`);
  setText("targetCaloriesValue", `${CALORIE_TARGET} kcal`);

  setText(
    "nutritionStatus",
    `${number(carbs)} g glucides · ${number(fat)} g lipides`
  );

  const count = todayFoods.length;

  setText(
    "foodCount",
    `${count} entrée${count > 1 ? "s" : ""}`
  );

  const history = $("foodHistory");
  if (!history) return;

  if (count === 0) {
    history.innerHTML =
      '<p class="muted">Aucune consommation enregistrée aujourd’hui.</p>';
    return;
  }

  history.innerHTML = todayFoods.map(item => {
    const name = escapeHTML(
      item.product_name_snapshot || "Aliment"
    );

    const unit = item.quantity_unit || "g";
    const quantity = number(item.quantity_value ?? item.quantity_g, 1);
    const unitLabel = unit === "piece" ? "pièce(s)" : unit;
    const kcal = number(item.kcal, 0);
    const proteinValue = number(item.protein_g);

    const time = formatDate(item.consumed_at, {
      hour: "2-digit",
      minute: "2-digit"
    });

    return `
      <div class="food-history-item">
        <div>
          <strong>${name}</strong>
          <p class="muted">${time} · ${quantity} ${unitLabel}</p>
          <small>${kcal} kcal · ${proteinValue} g protéines</small>
        </div>
        <button
          class="quiet"
          type="button"
          data-delete-food="${escapeHTML(item.id)}"
        >Supprimer</button>
      </div>
    `;
  }).join("");

  history.querySelectorAll("[data-delete-food]").forEach(button => {
    button.addEventListener("click", () => {
      deleteFood(button.dataset.deleteFood);
    });
  });
}

/* =====================================================
   NUTRITION : SAISIE MANUELLE
===================================================== */

/* =====================================================
   UNITÉS : LIBELLÉS ET BASE NUTRITIONNELLE
===================================================== */

function nutritionBasisForQuantityUnit(unit) {
  return unit === "ml" ? "ml" : "g";
}

function updateUnitLabels(prefix, unit) {
  const basis = nutritionBasisForQuantityUnit(unit);
  const basisLabel = basis === "ml" ? "100 ml" : "100 g";
  const basisSelect = $(prefix + "NutritionBasis");
  if (basisSelect) {
    basisSelect.value = basis;
    basisSelect.disabled = true;
  }
  const labels = prefix === "food"
    ? [["foodKcalLabel", `Calories pour ${basisLabel} (kcal)`], ["foodProteinLabel", `Protéines pour ${basisLabel}`], ["foodCarbsLabel", `Glucides pour ${basisLabel}`], ["foodFatLabel", `Lipides pour ${basisLabel}`]]
    : [["scanKcalLabel", `Calories pour ${basisLabel}`], ["scanProteinLabel", `Protéines pour ${basisLabel}`], ["scanCarbsLabel", `Glucides pour ${basisLabel}`], ["scanFatLabel", `Lipides pour ${basisLabel}`]];
  labels.forEach(([id, text]) => setText(id, text));
}

function updateFoodUnitLabels() {
  const unit = $("foodQuantityUnit")?.value || "g";
  updateUnitLabels("food", unit);
  const pieceField = $("foodPieceWeight");
  $("foodPieceWeightLabel")?.classList.toggle("hidden", unit !== "piece");
  pieceField?.classList.toggle("hidden", unit !== "piece");
}

function updateScanUnitLabels() {
  const unit = $("scanQuantityUnit")?.value || "g";
  updateUnitLabels("scan", unit);
  const pieceField = $("scanPieceWeight");
  $("scanPieceWeightLabel")?.classList.toggle("hidden", unit !== "piece");
  pieceField?.classList.toggle("hidden", unit !== "piece");
}

async function saveFood(event) {
  event.preventDefault();

  const button = $("foodForm").querySelector(
    'button[type="submit"]'
  );

  button.disabled = true;

  showMessage("foodMessage", "Enregistrement…");

  const quantity = Number($("foodQuantity").value);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    showMessage(
      "foodMessage",
      "Indique une quantité valide.",
      true
    );

    button.disabled = false;
    return;
  }

  const unit = $("foodQuantityUnit").value;
  const basis = $("foodNutritionBasis").value;
  const pieceWeight = Number($("foodPieceWeight").value || 0);
  if (unit === "piece" && pieceWeight <= 0) { showMessage("foodMessage", "Indique le poids d’une pièce pour calculer les valeurs nutritionnelles.", true); button.disabled = false; return; }
  if (unit === "ml" && basis !== "ml") { showMessage("foodMessage", "Pour un liquide, renseigne les valeurs pour 100 ml.", true); button.disabled = false; return; }
  if (unit !== "ml" && basis !== "g") { showMessage("foodMessage", "Pour cet aliment, renseigne les valeurs pour 100 g.", true); button.disabled = false; return; }
  const nutritionQuantity = unit === "piece" ? quantity * pieceWeight : quantity;
  const factor = nutritionQuantity / 100;
  const row = {
    user_id: currentUser.id,
    product_name_snapshot: $("foodName").value.trim(),
    quantity_g: unit === "ml" ? null : nutritionQuantity,
    quantity_value: quantity,
    quantity_unit: unit,
    nutrition_basis_unit: basis,
    kcal: Number($("foodKcal").value) * factor,
    protein_g: Number($("foodProtein").value) * factor,
    carbs_g: Number($("foodCarbs").value || 0) * factor,
    fat_g: Number($("foodFat").value || 0) * factor
  };

  try {
    const { error } = await client
      .from("nutrition_logs")
      .insert(row);

    if (error) throw error;

    $("foodForm").reset();

    const refreshed = await loadNutrition();

    showMessage(
      "foodMessage",
      refreshed
        ? "Consommation enregistrée."
        : "Consommation enregistrée, mais actualisation impossible."
    );

  } catch (error) {
    console.error("Erreur saisie manuelle :", error);

    showMessage(
      "foodMessage",
      `Erreur : ${error.message}`,
      true
    );

  } finally {
    button.disabled = false;
  }
}

/* =====================================================
   NUTRITION : SUPPRESSION
===================================================== */

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

/* =====================================================
   ENTRAÎNEMENTS
===================================================== */

async function loadWorkouts() {
  const { count, error } = await client
    .from("strength_workouts")
    .select("*", { count: "exact", head: true })
    .eq("user_id", currentUser.id)
    .gte("started_at", getStartOfWeek());

  if (error) {
    console.error("Erreur séances", error);
    setText("workoutsValue", "—");
    return;
  }

  setText("workoutsValue", String(count || 0));
}

/* =====================================================
   WITHINGS : CHARGEMENT
===================================================== */

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

/* =====================================================
   WITHINGS : DERNIÈRE MESURE
===================================================== */

function renderLatestWithings() {
  const latest = withingsRows.find(row =>
    row.weight_kg !== null && row.weight_kg !== undefined
  );

  if (!latest) {
    setText("weightValue", "—");
    setText("weightDate", "Aucune pesée Withings synchronisée");
    setText("compWeight", "—");
    setText("compositionDate", "Aucune donnée");

    setText(
      "weightProgress",
      "Synchronise Withings pour afficher tes mesures."
    );

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

  setText(
    "compFatKg",
    latest.fat_mass_kg == null
      ? "—"
      : kg(latest.fat_mass_kg)
  );

  setText("compMuscle", kg(latest.muscle_mass_kg));
  setText("compLean", kg(latest.lean_mass_kg));
  setText("compBone", kg(latest.bone_mass_kg));

  setText(
    "compVisceral",
    latest.visceral_fat_index == null
      ? "—"
      : number(latest.visceral_fat_index, 0)
  );

  setText("compWater", pct(latest.water_pct));

  setText("compositionDate", formatDate(latest.measured_at, {
    day: "numeric",
    month: "short",
    year: "numeric"
  }));

  setText(
    "weightProgress",
    `Écart avec ton objectif : ${number(
      Number(latest.weight_kg) - TARGET_WEIGHT
    )} kg`
  );
}

/* =====================================================
   PESÉE MANUELLE
===================================================== */

async function saveManualWeight(event) {
  event.preventDefault();

  const value = Number($("weightInput").value);

  if (!Number.isFinite(value) || value < 30 || value > 300) {
    showMessage("weightMessage", "Entre un poids valide.", true);
    return;
  }

  const { error } = await client
    .from("body_measurements")
    .insert({
      user_id: currentUser.id,
      measured_at: new Date().toISOString(),
      source: "manual",
      external_id: `manual-${Date.now()}`,
      weight_kg: value
    });

  if (error) {
    showMessage(
      "weightMessage",
      `Erreur : ${error.message}`,
      true
    );

    return;
  }

  $("weightForm").reset();

  showMessage(
    "weightMessage",
    "Pesée manuelle enregistrée. Elle reste séparée de Withings."
  );
}

/* =====================================================
   GRAPHIQUES WITHINGS
===================================================== */

function renderCharts() {
  const cutoff = Date.now() - currentPeriod * 86400000;

  const rows = withingsRows
    .filter(row =>
      new Date(row.measured_at).getTime() >= cutoff
    )
    .sort((a, b) =>
      new Date(a.measured_at) - new Date(b.measured_at)
    );

  renderSingleChart(
    "weightChart",
    rows,
    "weight_kg",
    "kg",
    "weightChange"
  );

  renderSingleChart(
    "fatChart",
    rows,
    "body_fat_pct",
    "%",
    "fatChange"
  );

  renderSingleChart(
    "muscleChart",
    rows,
    "muscle_mass_kg",
    "kg",
    "muscleChange"
  );
}

function renderSingleChart(
  containerId,
  rows,
  key,
  unit,
  changeId
) {
  const host = $(containerId);
  if (!host) return;

  const points = rows.filter(row =>
    row[key] !== null &&
    row[key] !== undefined &&
    Number.isFinite(Number(row[key]))
  );

  if (!points.length) {
    host.innerHTML =
      '<p class="muted">Pas encore assez de mesures Withings sur cette période.</p>';

    setText(changeId, "—");
    return;
  }

  const values = points.map(row => Number(row[key]));

  const min = Math.min(...values);
  const max = Math.max(...values);

  const range = Math.max(
    max - min,
    unit === "%" ? 0.5 : 0.3
  );

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

    const y =
      top + (high - Number(row[key])) / (high - low) * plotHeight;

    return {
      x,
      y,
      row,
      value: Number(row[key])
    };
  });

  const path = coords.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
  ).join(" ");

  const circles = coords.map(point =>
    `<circle cx="${point.x}" cy="${point.y}" r="3.5">
      <title>${number(point.value)} ${unit} · ${formatDate(
        point.row.measured_at,
        {
          day: "numeric",
          month: "short"
        }
      )}</title>
    </circle>`
  ).join("");

  const difference = values[values.length - 1] - values[0];
  const sign = difference > 0 ? "+" : "";

  setText(
    changeId,
    `${sign}${number(difference)} ${unit}`
  );

  const startLabel = formatDate(points[0].measured_at, {
    day: "numeric",
    month: "short"
  });

  const endLabel = formatDate(
    points[points.length - 1].measured_at,
    {
      day: "numeric",
      month: "short"
    }
  );

  host.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      <line class="chart-gridline"
        x1="${left}" y1="${top + plotHeight / 2}"
        x2="${width - right}" y2="${top + plotHeight / 2}"></line>
      <line class="chart-gridline"
        x1="${left}" y1="${top + plotHeight}"
        x2="${width - right}" y2="${top + plotHeight}"></line>
      <text class="chart-axis" x="2" y="${top + 4}">${number(high)}</text>
      <text class="chart-axis" x="2" y="${top + plotHeight}">${number(low)}</text>
      <path class="chart-line" d="${path}"></path>
      ${circles}
      <text class="chart-axis" x="${left}" y="${height - 4}">${startLabel}</text>
      <text class="chart-axis" text-anchor="end"
        x="${width - right}" y="${height - 4}">${endLabel}</text>
    </svg>
    <div class="chart-latest">
      ${number(values[values.length - 1])} ${unit} ·
      ${points.length} mesure${points.length > 1 ? "s" : ""}
    </div>
  `;
}

/* =====================================================
   SCANNER EAN - ZXING - OPEN FOOD FACTS
===================================================== */

async function startScanner() {
  if (scannerControls || scannerBusy) return;

  const video = $("scannerVideo");
  const panel = $("scannerPanel");

  if (!video || !panel) return;

  if (!window.ZXing?.BrowserMultiFormatReader) {
    showMessage(
      "scannerMessage",
      "Le lecteur ZXing n'a pas pu être chargé. Vérifie ta connexion Internet.",
      true
    );

    panel.classList.remove("hidden");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    panel.classList.remove("hidden");

    showMessage(
      "scannerMessage",
      "La caméra nécessite une connexion sécurisée HTTPS et un navigateur compatible.",
      true
    );

    return;
  }

  scannerBusy = true;
  scanDetected = false;

  panel.classList.remove("hidden");
  $("scannedProduct")?.classList.add("hidden");

  showMessage(
    "scannerMessage",
    "Demande d'autorisation de la caméra…"
  );

  try {
    scannerReader = new ZXing.BrowserMultiFormatReader();

    scannerControls = await scannerReader.decodeFromConstraints(
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" }
        }
      },
      video,
      async (result, error) => {
        if (result && !scanDetected) {
          scanDetected = true;

          const barcode = result.getText();

          await stopScanner();
          await lookupOpenFoodFacts(barcode);
        }
      }
    );

    scannerBusy = false;

    showMessage(
      "scannerMessage",
      "Place le code-barres devant la caméra."
    );

  } catch (error) {
    console.error("Erreur caméra", error);

    scannerBusy = false;
    await stopScanner();

    panel.classList.remove("hidden");

    showMessage(
      "scannerMessage",
      `Impossible d'ouvrir la caméra : ${error.message || "autorisation refusée"}.`,
      true
    );
  }
}

async function stopScanner() {
  scannerBusy = true;

  try {
    if (scannerControls) {
      scannerControls.stop();
      scannerControls = null;
    }

    if (scannerReader) {
      scannerReader.reset();
      scannerReader = null;
    }

    const video = $("scannerVideo");

    if (video?.srcObject) {
      video.srcObject.getTracks().forEach(track => track.stop());
      video.srcObject = null;
    }

  } catch (error) {
    console.warn("Arrêt caméra", error);
  }

  scannerBusy = false;

  $("scannerPanel")?.classList.add("hidden");
}

/* =====================================================
   OPEN FOOD FACTS : RECHERCHE DU PRODUIT
===================================================== */

async function lookupOpenFoodFacts(barcode) {
  showMessage("scanSaveMessage", "");
  $("scannedProduct")?.classList.add("hidden");

  showMessage("scannerMessage", "Recherche du produit…");

  try {
    const url =
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`;

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        "La base de produits est momentanément indisponible."
      );
    }

    const result = await response.json();

    if (result.status !== 1 || !result.product) {
      $("scannerPanel")?.classList.remove("hidden");

      showMessage(
        "scannerMessage",
        `Produit ${barcode} introuvable dans Open Food Facts. Tu peux utiliser la saisie manuelle.`,
        true
      );

      return;
    }

    const product = result.product;
    const nutriments = product.nutriments || {};

    const kcal =
      nutriments["energy-kcal_100g"] ??
      (
        nutriments["energy-kj_100g"] != null
          ? Number(nutriments["energy-kj_100g"]) / 4.184
          : null
      );

    scannedProductData = {
      barcode,
      name:
        product.product_name ||
        product.product_name_fr ||
        "Produit sans nom",
      brand: product.brands || "",
      kcal: kcal == null ? 0 : Number(kcal),
      protein: Number(nutriments.proteins_100g || 0),
      carbs: Number(nutriments.carbohydrates_100g || 0),
      fat: Number(nutriments.fat_100g || 0),
      sugars: Number(nutriments.sugars_100g || 0),
      fiber: Number(nutriments.fiber_100g || 0)
    };

    showScannedProduct();

  } catch (error) {
    console.error("Recherche Open Food Facts", error);

    $("scannerPanel")?.classList.remove("hidden");

    showMessage(
      "scannerMessage",
      `Erreur de recherche : ${error.message}`,
      true
    );
  }
}

/* =====================================================
   SCANNER : AFFICHAGE DU PRODUIT
===================================================== */

function showScannedProduct() {
  const product = scannedProductData;
  if (!product) return;

  setText("scannedProductName", product.name);

  setText(
    "scannedProductDetails",
    product.brand
      ? `Marque : ${product.brand}`
      : "Marque non renseignée"
  );

  $("scanCalories").value = product.kcal;
  $("scanProtein").value = product.protein;
  $("scanCarbs").value = product.carbs;
  $("scanFat").value = product.fat;

  $("scanQuantity").value = "";

  showMessage("scanSaveMessage", "");

  $("scannerPanel")?.classList.add("hidden");
  $("scannedProduct")?.classList.remove("hidden");

  updateScanPreview();

  $("scanQuantity")?.focus();
}

/* =====================================================
   SCANNER : CALCUL DES MACROS
===================================================== */

function updateScanPreview() {
  const quantity = Math.max(
    0,
    Number($("scanQuantity")?.value || 0)
  );

  const unit = $("scanQuantityUnit")?.value || "g";
  const basis = $("scanNutritionBasis")?.value || "g";
  const pieceWeight = Number($("scanPieceWeight")?.value || 0);
  const effectiveQuantity = unit === "piece" ? quantity * pieceWeight : quantity;
  const factor = effectiveQuantity / 100;

  const kcal =
    Number($("scanCalories")?.value || 0) * factor;

  const protein =
    Number($("scanProtein")?.value || 0) * factor;

  const carbs =
    Number($("scanCarbs")?.value || 0) * factor;

  const fat =
    Number($("scanFat")?.value || 0) * factor;

  setText(
    "scanPreview",
    `Pour ${number(quantity, 1)} ${unit === "piece" ? "pièce(s)" : unit} : ${number(kcal, 0)} kcal · ` +
    `${number(protein)} g protéines · ${number(carbs)} g glucides · ` +
    `${number(fat)} g lipides`
  );
}

/* =====================================================
   BIBLIOTHÈQUE ALIMENTAIRE PERSONNELLE
===================================================== */

async function loadFoodLibrary() {
  if (!client || !currentUser) return false;

  const { data, error } = await client
    .from("food_products")
    .select("id,user_id,name,brand,barcode,serving_basis_g,serving_basis_value,serving_basis_unit,nutrition_basis_unit,piece_weight_g,kcal,protein_g,carbs_g,fat_g,sugars_g,fiber_g,source")
    .eq("user_id", currentUser.id)
    .order("name", { ascending: true });

  if (error) {
    console.error("Erreur bibliothèque alimentaire :", error);
    showMessage("libraryMessage", `Chargement impossible : ${error.message}`, true);
    return false;
  }

  libraryProducts = data || [];
  renderFoodLibrary();
  return true;
}

function renderFoodLibrary() {
  const host = $("foodLibrary");
  if (!host) return;

  const term = ($("librarySearch")?.value || "").trim().toLocaleLowerCase("fr");
  const filtered = libraryProducts.filter(product =>
    [product.name, product.brand, product.barcode]
      .some(value => String(value || "").toLocaleLowerCase("fr").includes(term))
  );

  setText("libraryCount", `${libraryProducts.length} produit${libraryProducts.length > 1 ? "s" : ""}`);

  if (!filtered.length) {
    host.innerHTML = libraryProducts.length
      ? '<p class="muted">Aucun produit ne correspond à cette recherche.</p>'
      : '<p class="muted">Ta bibliothèque est vide. Après un scan, utilise « Ajouter à ma bibliothèque » pour conserver un produit.</p>';
    return;
  }

  host.innerHTML = filtered.map(product => `
    <div class="library-item">
      <div class="library-item-info">
        <strong>${escapeHTML(product.name)}</strong>
        <small>${escapeHTML(product.brand || "Sans marque")} · ${number(product.kcal, 0)} kcal · ${number(product.protein_g)} g protéines / 100 ${product.nutrition_basis_unit || "g"}</small>
      </div>
      <div class="library-item-actions">
        <button class="primary compact" type="button" data-use-food="${escapeHTML(product.id)}">Ajouter au journal</button>
        <button class="quiet danger-text" type="button" data-delete-library="${escapeHTML(product.id)}">Retirer</button>
      </div>
    </div>
  `).join("");

  host.querySelectorAll("[data-use-food]").forEach(button => {
    button.addEventListener("click", () => addLibraryProductToJournal(button.dataset.useFood));
  });
  host.querySelectorAll("[data-delete-library]").forEach(button => {
    button.addEventListener("click", () => deleteLibraryProduct(button.dataset.deleteLibrary));
  });
}

async function saveScannedToLibrary() {
  if (!client || !currentUser || !scannedProductData) {
    showMessage("scanSaveMessage", "Aucun produit scanné à enregistrer.", true);
    return;
  }

  const product = scannedProductData;
  const name = product.name.trim();
  const brand = product.brand.trim();
  if (!name) {
    showMessage("scanSaveMessage", "Le produit doit avoir un nom.", true);
    return;
  }

  const button = $("saveScannedToLibrary");
  button.disabled = true;
  showMessage("scanSaveMessage", "Vérification des doublons…");

  try {
    let duplicateQuery = client.from("food_products").select("id,name").eq("user_id", currentUser.id);
    if (product.barcode) {
      duplicateQuery = duplicateQuery.eq("barcode", product.barcode);
    } else {
      duplicateQuery = duplicateQuery.eq("name", name);
      duplicateQuery = brand
        ? duplicateQuery.eq("brand", brand)
        : duplicateQuery.is("brand", null);
    }
    const { data: duplicates, error: duplicateError } = await duplicateQuery.limit(1);
    if (duplicateError) throw duplicateError;

    if (duplicates?.length) {
      showMessage("scanSaveMessage", "Ce produit est déjà dans ta bibliothèque. Tu peux le retrouver dans la liste ci-dessous.");
      await loadFoodLibrary();
      return;
    }

    const row = {
      user_id: currentUser.id,
      name,
      brand: brand || null,
      barcode: product.barcode || null,
      serving_basis_g: 100,
      serving_basis_value: Number($("scanQuantity").value || 100),
      serving_basis_unit: $("scanQuantityUnit").value,
      nutrition_basis_unit: $("scanNutritionBasis").value,
      piece_weight_g: $("scanQuantityUnit").value === "piece" ? Number($("scanPieceWeight").value || 0) : null,
      kcal: Number($("scanCalories").value),
      protein_g: Number($("scanProtein").value),
      carbs_g: Number($("scanCarbs").value),
      fat_g: Number($("scanFat").value),
      sugars_g: Number(product.sugars || 0),
      fiber_g: Number(product.fiber || 0),
      source: "openfoodfacts"
    };

    const { error } = await client.from("food_products").insert(row);
    if (error) throw error;

    await loadFoodLibrary();
    showMessage("scanSaveMessage", "Produit ajouté à ta bibliothèque. Il n'a pas été ajouté au journal.");
  } catch (error) {
    console.error("Ajout bibliothèque :", error);
    showMessage("scanSaveMessage", `Ajout impossible : ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

async function addLibraryProductToJournal(id) {
  const product = libraryProducts.find(item => item.id === id);
  if (!product) return;
  const unit = product.serving_basis_unit || "g";
  const basis = product.nutrition_basis_unit || "g";
  const suggested = product.serving_basis_value || product.serving_basis_g || (unit === "ml" ? 250 : 100);
  const raw = prompt(`Quantité consommée de « ${product.name} » en ${unit === "piece" ? "pièce(s)" : unit} :`, String(suggested));
  if (raw === null) return;
  const quantity = Number(raw.replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0) { alert("Indique une quantité supérieure à 0."); return; }
  let pieceWeight = Number(product.piece_weight_g || 0);
  if (unit === "piece" && pieceWeight <= 0) {
    const weightRaw = prompt("Poids d’une pièce en grammes (nécessaire au calcul) :", "");
    if (weightRaw === null) return;
    pieceWeight = Number(weightRaw.replace(",", "."));
    if (!Number.isFinite(pieceWeight) || pieceWeight <= 0) { alert("Poids par pièce invalide."); return; }
  }
  const nutritionQuantity = unit === "piece" ? quantity * pieceWeight : quantity;
  const factor = nutritionQuantity / 100;
  const row = {
    user_id: currentUser.id, product_id: product.id,
    product_name_snapshot: product.name,
    quantity_g: unit === "ml" ? null : nutritionQuantity,
    quantity_value: quantity, quantity_unit: unit,
    nutrition_basis_unit: basis,
    kcal: Number(product.kcal || 0) * factor,
    protein_g: Number(product.protein_g || 0) * factor,
    carbs_g: Number(product.carbs_g || 0) * factor,
    fat_g: Number(product.fat_g || 0) * factor
  };
  const { error } = await client.from("nutrition_logs").insert(row);
  if (error) { alert(`Impossible d'ajouter cet aliment : ${error.message}`); return; }
  await loadNutrition();
  showMessage("libraryMessage", `${product.name} ajouté au journal (${number(quantity, 1)} ${unit === "piece" ? "pièce(s)" : unit}).`);
}

async function deleteLibraryProduct(id) {
  const product = libraryProducts.find(item => item.id === id);
  if (!product) return;
  if (!confirm(`Retirer « ${product.name} » de ta bibliothèque ? Les consommations déjà enregistrées ne seront pas supprimées.`)) return;

  const { error } = await client.from("food_products")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);
  if (error) {
    showMessage("libraryMessage", `Suppression impossible : ${error.message}`, true);
    return;
  }
  await loadFoodLibrary();
  showMessage("libraryMessage", "Produit retiré de ta bibliothèque.");
}

/* =====================================================
   SCANNER : ENREGISTREMENT
===================================================== */

async function addScannedProduct() {
  const button = $("addScannedProduct");

  if (!client || !currentUser || !scannedProductData) {
    showMessage(
      "scanSaveMessage",
      "Session ou produit manquant.",
      true
    );

    return;
  }

  const quantityInput = $("scanQuantity");
  const quantity = Number(quantityInput.value);
  const unit = $("scanQuantityUnit").value;
  const basis = $("scanNutritionBasis").value;
  const pieceWeight = Number($("scanPieceWeight").value || 0);

  if (
    quantityInput.value.trim() === "" ||
    !Number.isFinite(quantity) ||
    quantity <= 0
  ) {
    showMessage(
      "scanSaveMessage",
      "Indique obligatoirement une quantité supérieure à 0 g.",
      true
    );

    quantityInput.focus();
    return;
  }

  const fields = [
    "scanCalories",
    "scanProtein",
    "scanCarbs",
    "scanFat"
  ];

  if (fields.some(id =>
    $(id).value.trim() === "" ||
    !Number.isFinite(Number($(id).value)) ||
    Number($(id).value) < 0
  )) {
    showMessage(
      "scanSaveMessage",
      "Vérifie les valeurs nutritionnelles.",
      true
    );

    return;
  }

  if (unit === "piece" && pieceWeight <= 0) { showMessage("scanSaveMessage", "Indique le poids d’une pièce.", true); return; }
  if ((unit === "ml") !== (basis === "ml")) { showMessage("scanSaveMessage", "L’unité de consommation doit correspondre à la base nutritionnelle (g ou ml).", true); return; }
  const nutritionQuantity = unit === "piece" ? quantity * pieceWeight : quantity;
  const factor = nutritionQuantity / 100;

  const row = {
    user_id: currentUser.id,
    product_name_snapshot: scannedProductData.name,
    quantity_g: unit === "ml" ? null : nutritionQuantity,
    quantity_value: quantity,
    quantity_unit: unit,
    nutrition_basis_unit: basis,
    kcal: Number($("scanCalories").value) * factor,
    protein_g: Number($("scanProtein").value) * factor,
    carbs_g: Number($("scanCarbs").value) * factor,
    fat_g: Number($("scanFat").value) * factor
  };

  button.disabled = true;

  showMessage(
    "scanSaveMessage",
    "Enregistrement en cours…"
  );

  try {
    const { error } = await client
      .from("nutrition_logs")
      .insert(row);

    if (error) throw error;

    const productName = scannedProductData.name;

    scannedProductData = null;

    const refreshed = await loadNutrition();

    if (!refreshed) {
      showMessage(
        "scanSaveMessage",
        "Produit enregistré, mais actualisation des macros impossible. Utilise Actualiser.",
        true
      );

      return;
    }

    showMessage(
      "scanSaveMessage",
      `${productName} (${quantity} ${unit === "piece" ? "pièce(s)" : unit}) ajouté au journal.`
    );

    setTimeout(() => {
      $("scannedProduct")?.classList.add("hidden");
    }, 2500);

  } catch (error) {
    console.error("Erreur enregistrement scanner :", error);

    showMessage(
      "scanSaveMessage",
      `Échec de l'enregistrement : ${error.message}`,
      true
    );

  } finally {
    button.disabled = false;
  }
}

/* =====================================================
   SCANNER : ANNULATION
===================================================== */

function cancelScannedProduct() {
  scannedProductData = null;

  $("scannedProduct")?.classList.add("hidden");
  $("scannerPanel")?.classList.add("hidden");

  showMessage("scanSaveMessage", "");
}

/* =====================================================
   WITHINGS : CONNEXION
===================================================== */

async function connectWithings() {
  showMessage(
    "withingsMessage",
    "Ouverture de la connexion Withings…"
  );

  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData.session?.access_token;

  if (!token) {
    showMessage(
      "withingsMessage",
      "Session expirée. Reconnecte-toi.",
      true
    );

    return;
  }

  const { data, error } = await client.functions.invoke(
    "withings-connect",
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (error || !data?.url) {
    console.error(error, data);

    showMessage(
      "withingsMessage",
      error?.message || "Impossible de démarrer la connexion.",
      true
    );

    return;
  }

  window.location.href = data.url;
}

/* =====================================================
   WITHINGS : SYNCHRONISATION
===================================================== */

async function syncWithings() {
  const button = $("withingsSync");
  if (!button) return;

  button.disabled = true;

  showMessage(
    "withingsMessage",
    "Synchronisation Withings en cours…"
  );

  try {
    const { data: sessionData } = await client.auth.getSession();
    const token = sessionData.session?.access_token;

    if (!token) {
      throw new Error("Session expirée. Reconnecte-toi.");
    }

    const { data, error } = await client.functions.invoke(
      "withings-sync",
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    if (error) throw error;

    showMessage(
      "withingsMessage",
      data?.message ||
      `${data?.imported ?? 0} mesure(s) synchronisée(s).`
    );

    await loadWithings();

  } catch (error) {
    console.error("Synchronisation Withings", error);

    showMessage(
      "withingsMessage",
      error.message || "Erreur de synchronisation.",
      true
    );

  } finally {
    button.disabled = false;
  }
}

/* =====================================================
   DÉMARRAGE DE L'APPLICATION
===================================================== */

document.addEventListener("DOMContentLoaded", init);
