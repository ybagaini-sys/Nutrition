
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

  $("withingsConnect")?.addEventListener("click", connectWithings);
  $("withingsSync")?.addEventListener("click", syncWithings);

  $("startScanner")?.addEventListener("click", startScanner);
  $("stopScanner")?.addEventListener("click", stopScanner);
  $("addScannedProduct")?.addEventListener("click", addScannedProduct);
  $("cancelScannedProduct")?.addEventListener("click", cancelScannedProduct);

  [
    "scanCalories",
    "scanProtein",
    "scanCarbs",
    "scanFat",
    "scanQuantity"
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
  await loadDashboard();
}

async function logout() {
  await stopScanner();

  const { error } = await client.auth.signOut();

  if (error) {
    showMessage("authMessage", error.message, true);
    return;
  }

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

    const quantity = number(item.quantity_g, 0);
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
          <p class="muted">${time} · ${quantity} g</p>
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

async function saveFood(event) {
  event.preventDefault();

  const button = $("foodForm").querySelector(
    'button[type="submit"]'
  );

  button.disabled = true;

  showMessage("foodMessage", "Enregistrement…");

  const quantity = Number($("foodQuantity").value);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    showMessage("foodMessage", "Indique une quantité valide.", true);
    button.disabled = false;
    return;
  }

  const payload = {
    user_id: currentUser.id,
    product_name_snapshot: $("foodName").value.trim(),
    quantity_g: quantity,
    kcal: Number($("foodCalories").value) || 0,
    protein_g: Number($("foodProtein").value) || 0,
    carbs_g: Number($("foodCarbs").value) || 0,
    fat_g: Number($("foodFat").value) || 0,
    consumed_at: new Date().toISOString()
  };

  if (!payload.product_name_snapshot) {
    showMessage("foodMessage", "Indique le nom de l'aliment.", true);
    button.disabled = false;
    return;
  }

  const { error } = await client
    .from("nutrition_logs")
    .insert(payload);

  if (error) {
    showMessage("foodMessage", error.message, true);
    button.disabled = false;
    return;
  }

  $("foodForm").reset();
  showMessage("foodMessage", "Aliment ajouté au journal.");
  await loadNutrition();

  button.disabled = false;
}

async function deleteFood(id) {
  if (!confirm("Supprimer cette consommation ?")) return;

  const { error } = await client
    .from("nutrition_logs")
    .delete()
    .eq("id", id)
    .eq("user_id", currentUser.id);

  if (error) {
    showMessage("foodMessage", error.message, true);
    return;
  }

  await loadNutrition();
}

/* =====================================================
   ENTRAÎNEMENTS
===================================================== */

async function loadWorkouts() {
  const { data, error } = await client
    .from("strength_workouts")
    .select("id,started_at,duration_seconds")
    .eq("user_id", currentUser.id)
    .gte("started_at", getStartOfWeek())
    .order("started_at", { ascending: false });

  if (error) {
    console.error("Erreur entraînements", error);
    return;
  }

  setText("workoutsValue", String((data || []).length));
}

/* =====================================================
   WITHINGS : CHARGEMENT
===================================================== */

async function loadWithings() {
  const { data, error } = await client
    .from("body_measurements")
    .select("id,measured_at,source,weight_kg,body_fat_pct,fat_mass_kg,muscle_mass_kg,lean_mass_kg,water_pct,bone_mass_kg,visceral_fat_index")
    .eq("user_id", currentUser.id)
    .eq("source", "withings")
    .order("measured_at", { ascending: false })
    .limit(1000);

  if (error) {
    console.error("Erreur Withings", error);
    showMessage("withingsMessage", error.message, true);
    return;
  }

  withingsRows = data || [];
  renderLatestWithings();
  renderCharts();
}

function renderLatestWithings() {
  const latest = withingsRows[0];

  if (!latest) {
    setText("compositionDate", "Aucune mesure Withings");
    [
      "compWeight",
      "compFatPct",
      "compFatKg",
      "compMuscle",
      "compLean",
      "compBone",
      "compVisceral",
      "compWater"
    ].forEach(id => setText(id, "—"));
    return;
  }

  setText("compositionDate", formatDate(latest.measured_at, {
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }));

  setText("compWeight", kg(latest.weight_kg));
  setText("compFatPct", pct(latest.body_fat_pct));
  setText("compFatKg", kg(latest.fat_mass_kg));
  setText("compMuscle", kg(latest.muscle_mass_kg));
  setText("compLean", kg(latest.lean_mass_kg));
  setText("compBone", kg(latest.bone_mass_kg));
  setText("compVisceral", latest.visceral_fat_index ?? "—");
  setText("compWater", pct(latest.water_pct));
  setText("weightValue", kg(latest.weight_kg));
  setText("weightDate", formatDate(latest.measured_at, {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }));
}

/* =====================================================
   GRAPHIQUES
===================================================== */

function renderCharts() {
  const rows = [...withingsRows]
    .filter(row => row.measured_at)
    .sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - currentPeriod);

  const filtered = rows.filter(row =>
    new Date(row.measured_at) >= cutoff
  );

  renderSingleChart(
    "weightChart",
    filtered,
    "weight_kg",
    "Poids",
    "kg"
  );

  renderSingleChart(
    "fatChart",
    filtered,
    "body_fat_pct",
    "Masse grasse",
    "%"
  );

  renderSingleChart(
    "muscleChart",
    filtered,
    "muscle_mass_kg",
    "Masse musculaire",
    "kg"
  );

  const first = filtered[0];
  const last = filtered[filtered.length - 1];

  if (first && last && first !== last) {
    setText("weightChange", `${number(Number(last.weight_kg) - Number(first.weight_kg))} kg`);
    setText("fatChange", `${number(Number(last.body_fat_pct) - Number(first.body_fat_pct))} %`);
    setText("muscleChange", `${number(Number(last.muscle_mass_kg) - Number(first.muscle_mass_kg))} kg`);
  } else {
    setText("weightChange", "—");
    setText("fatChange", "—");
    setText("muscleChange", "—");
  }
}

function renderSingleChart(containerId, rows, key, title, unit) {
  const container = $(containerId);
  if (!container) return;

  const points = rows
    .filter(row => row[key] !== null && row[key] !== undefined)
    .map(row => ({
      date: new Date(row.measured_at),
      value: Number(row[key])
    }))
    .filter(point => Number.isFinite(point.value));

  if (!points.length) {
    container.innerHTML = '<p class="muted">Pas encore de données.</p>';
    return;
  }

  const width = 600;
  const height = 220;
  const left = 48;
  const right = 20;
  const top = 18;
  const bottom = 34;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;

  const values = points.map(point => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);

  if (min === max) {
    min -= 1;
    max += 1;
  }

  const padding = (max - min) * 0.12;
  min -= padding;
  max += padding;

  const x = index =>
    left + (points.length === 1
      ? plotWidth / 2
      : (index / (points.length - 1)) * plotWidth);

  const y = value =>
    top + ((max - value) / (max - min)) * plotHeight;

  const path = points.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${x(index)} ${y(point.value)}`
  ).join(" ");

  const circles = points.map((point, index) => `
    <circle cx="${x(index)}" cy="${y(point.value)}" r="4">
      <title>${formatDate(point.date, { day: "2-digit", month: "short" })} : ${number(point.value)} ${unit}</title>
    </circle>
  `).join("");

  container.innerHTML = `
    <div class="chart-heading">
      <strong>${escapeHTML(title)}</strong>
      <span>${number(points[points.length - 1].value)} ${unit}</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(title)}">
      <line class="chart-gridline"
        x1="${left}" y1="${top + plotHeight / 2}"
        x2="${width - right}" y2="${top + plotHeight / 2}"></line>
      <line class="chart-axis"
        x1="${left}" y1="${top}"
        x2="${left}" y2="${height - bottom}"></line>
      <path class="chart-line" d="${path}"></path>
      ${circles}
      <text class="chart-label" x="${left}" y="${height - 8}">
        ${formatDate(points[0].date, { day: "2-digit", month: "short" })}
      </text>
      <text class="chart-label" x="${width - right}" y="${height - 8}" text-anchor="end">
        ${formatDate(points[points.length - 1].date, { day: "2-digit", month: "short" })}
      </text>
    </svg>
  `;
}

/* =====================================================
   SAISIE MANUELLE DU POIDS
===================================================== */

async function saveManualWeight(event) {
  event.preventDefault();

  const button = $("weightForm").querySelector(
    'button[type="submit"]'
  );

  button.disabled = true;

  showMessage("weightMessage", "Enregistrement…");

  const weight = Number($("manualWeight").value);
  const date = $("manualWeightDate").value || new Date().toISOString().slice(0, 10);

  if (!Number.isFinite(weight) || weight <= 0) {
    showMessage("weightMessage", "Indique un poids valide.", true);
    button.disabled = false;
    return;
  }

  const { error } = await client
    .from("body_measurements")
    .insert({
      user_id: currentUser.id,
      measured_at: new Date(`${date}T12:00:00`).toISOString(),
      source: "manual",
      external_id: `manual-${Date.now()}`,
      weight_kg: weight
    });

  if (error) {
    showMessage("weightMessage", error.message, true);
    button.disabled = false;
    return;
  }

  $("weightForm").reset();
  showMessage("weightMessage", "Poids enregistré.");
  button.disabled = false;

  await loadWithings();
}

/* =====================================================
   SCANNER : DÉMARRAGE ET ARRÊT
===================================================== */

async function startScanner() {
  if (scannerBusy) return;

  if (!window.ZXing?.BrowserMultiFormatReader) {
    showMessage("scanMessage", "Le lecteur de codes-barres n'est pas disponible. Recharge la page.", true);
    return;
  }

  scannerBusy = true;
  scanDetected = false;

  $("scannerPanel")?.classList.remove("hidden");
  $("scannedProduct")?.classList.add("hidden");
  showMessage("scanMessage", "Démarrage de la caméra…");

  try {
    scannerReader = new ZXing.BrowserMultiFormatReader();

    scannerControls = await scannerReader.decodeFromConstraints(
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" }
        }
      },
      "scannerVideo",
      async (result, error) => {
        if (result && !scanDetected) {
          scanDetected = true;
          const barcode = result.getText();

          await stopScanner();
          await lookupOpenFoodFacts(barcode);
        }
      }
    );

    showMessage("scanMessage", "Place le code-barres devant la caméra.");

  } catch (error) {
    console.error("Erreur scanner", error);
    showMessage("scanMessage", `Impossible de démarrer la caméra : ${error.message}`, true);
    await stopScanner();
  } finally {
    scannerBusy = false;
  }
}

async function stopScanner() {
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
    console.warn("Arrêt scanner", error);
  }

  $("scannerPanel")?.classList.add("hidden");
  scannerBusy = false;
}

/* =====================================================
   SCANNER : RECHERCHE OPEN FOOD FACTS
===================================================== */

async function lookupOpenFoodFacts(barcode) {
  showMessage("scanMessage", "Recherche du produit…");

  try {
    const response = await fetch(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json`
    );

    if (!response.ok) {
      throw new Error("Le service Open Food Facts ne répond pas.");
    }

    const result = await response.json();

    if (result.status !== 1 || !result.product) {
      throw new Error("Produit introuvable dans Open Food Facts.");
    }

    const product = result.product;
    const nutriments = product.nutriments || {};

    scannedProductData = {
      barcode,
      name: product.product_name_fr || product.product_name || "Produit sans nom",
      brand: product.brands || "",
      kcal: Number(nutriments["energy-kcal_100g"] || 0),
      protein: Number(nutriments.proteins_100g || 0),
      carbs: Number(nutriments.carbohydrates_100g || 0),
      fat: Number(nutriments.fat_100g || 0)
    };

    showScannedProduct();

  } catch (error) {
    console.error("Recherche produit", error);
    showMessage("scanMessage", error.message, true);
  }
}

function showScannedProduct() {
  if (!scannedProductData) return;

  $("scannerPanel")?.classList.add("hidden");
  $("scannedProduct")?.classList.remove("hidden");

  setText("scanProductName", scannedProductData.name);
  setText("scanProductBrand", scannedProductData.brand || "Marque non renseignée");

  $("scanCalories").value = scannedProductData.kcal;
  $("scanProtein").value = scannedProductData.protein;
  $("scanCarbs").value = scannedProductData.carbs;
  $("scanFat").value = scannedProductData.fat;
  $("scanQuantity").value = "";

  updateScanPreview();
}

function updateScanPreview() {
  if (!scannedProductData) return;

  const quantity = Number($("scanQuantity")?.value || 0);
  const factor = quantity / 100;

  const calories = Number($("scanCalories")?.value || 0) * factor;
  const protein = Number($("scanProtein")?.value || 0) * factor;
  const carbs = Number($("scanCarbs")?.value || 0) * factor;
  const fat = Number($("scanFat")?.value || 0) * factor;

  setText("scanPreviewCalories", `${number(calories, 0)} kcal`);
  setText("scanPreviewProtein", `${number(protein)} g`);
  setText("scanPreviewCarbs", `${number(carbs)} g`);
  setText("scanPreviewFat", `${number(fat)} g`);
}

/* =====================================================
   SCANNER : AJOUT AU JOURNAL
===================================================== */

async function addScannedProduct() {
  if (!scannedProductData || !currentUser) return;

  const button = $("addScannedProduct");
  button.disabled = true;

  const quantity = Number($("scanQuantity").value);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    showMessage("scanSaveMessage", "Indique une quantité en grammes supérieure à zéro.", true);
    button.disabled = false;
    return;
  }

  const factor = quantity / 100;

  const payload = {
    user_id: currentUser.id,
    product_name_snapshot: scannedProductData.name,
    quantity_g: quantity,
    kcal: Number($("scanCalories").value || 0) * factor,
    protein_g: Number($("scanProtein").value || 0) * factor,
    carbs_g: Number($("scanCarbs").value || 0) * factor,
    fat_g: Number($("scanFat").value || 0) * factor,
    consumed_at: new Date().toISOString()
  };

  try {
    const { error } = await client
      .from("nutrition_logs")
      .insert(payload);

    if (error) throw error;

    showMessage("scanSaveMessage", "Consommation ajoutée au journal.");
    await loadNutrition();

    $("scannedProduct")?.classList.add("hidden");
    scannedProductData = null;

  } catch (error) {
    console.error("Ajout consommation", error);
    showMessage("scanSaveMessage", `Impossible d'enregistrer : ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function cancelScannedProduct() {
  scannedProductData = null;
  $("scannedProduct")?.classList.add("hidden");
  showMessage("scanMessage", "");
  showMessage("scanSaveMessage", "");
}

/* =====================================================
   WITHINGS : CONNEXION
===================================================== */

async function connectWithings() {
  const button = $("withingsConnect");
  button.disabled = true;

  showMessage("withingsMessage", "Connexion à Withings…");

  try {
    const { data, error } = await client.functions.invoke(
      "withings-connect"
    );

    if (error) throw error;

    if (!data?.url) {
      throw new Error("L'URL de connexion Withings n'a pas été reçue.");
    }

    window.location.href = data.url;

  } catch (error) {
    console.error("Connexion Withings", error);
    showMessage("withingsMessage", error.message, true);
    button.disabled = false;
  }
}

/* =====================================================
   WITHINGS : SYNCHRONISATION
===================================================== */

async function syncWithings() {
  const button = $("withingsSync");
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
