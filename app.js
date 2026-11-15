
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

  ["scanCalories", "scanProtein", "scanCarbs", "scanFat", "scanQuantity"]
    .forEach(id => {
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
      stopScanner();
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

  stopScanner();
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

  if (
    monthDiff < 0 ||
    (monthDiff === 0 && new Date().getDate() < birth.getDate())
  ) age--;

  setText("ageValue", `${age} ans`);
  setText("heightValue", `${number(height, 0)} cm`);
  setText("targetValue", `${TARGET_WEIGHT} kg`);
  setText("weightGoal", `${TARGET_WEIGHT} kg`);
  setText("proteinTarget", `Objectif : ${TARGET_PROTEIN} g`);
}

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

renderNutrition

async function saveFood(event) {
  event.preventDefault();

  const button = $("foodForm").querySelector('button[type="submit"]');
  button.disabled = true;

  showMessage("foodMessage", "Enregistrement…");

  const quantity = Number($("foodQuantity").value);

  if (!Number.isFinite(quantity) || quantity <= 0) {
    showMessage("foodMessage", "Indique une quantité valide.", true);
    button.disabled = false;
    return;
  }

  const row = {
    user_id: currentUser.id,
    product_name_snapshot: $("foodName").value.trim(),
    quantity_g: quantity,
    kcal: Number($("foodKcal").value),
    protein_g: Number($("foodProtein").value),
    carbs_g: Number($("foodCarbs").value || 0),
    fat_g: Number($("foodFat").value || 0)
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
    showMessage("foodMessage", `Erreur : ${error.message}`, true);
  } finally {
    button.disabled = false;
  }
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
  const latest = withingsRows.find(row =>
    row.weight_kg !== null && row.weight_kg !== undefined
  );

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
    `Écart avec ton objectif : ${number(Number(latest.weight_kg) - TARGET_WEIGHT)} kg`
  );
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

  showMessage(
    "weightMessage",
    "Pesée manuelle enregistrée. Elle reste séparée de Withings."
  );
}

function renderCharts() {
  const cutoff = Date.now() - currentPeriod * 86400000;

  const rows = withingsRows
    .filter(row => new Date(row.measured_at).getTime() >= cutoff)
    .sort((a, b) =>
      new Date(a.measured_at) - new Date(b.measured_at)
    );

  renderSingleChart("weightChart", rows, "weight_kg", "kg", "weightChange");
  renderSingleChart("fatChart", rows, "body_fat_pct", "%", "fatChange");
  renderSingleChart("muscleChart", rows, "muscle_mass_kg", "kg", "muscleChange");
}

function renderSingleChart(containerId, rows, key, unit, changeId) {
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

    const y =
      top + (high - Number(row[key])) / (high - low) * plotHeight;

    return { x, y, row, value: Number(row[key]) };
  });

  const path = coords.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`
  ).join(" ");

  const circles = coords.map(point =>
    `<circle cx="${point.x}" cy="${point.y}" r="3.5">
      <title>${number(point.value)} ${unit} · ${formatDate(point.row.measured_at, {
        day: "numeric",
        month: "short"
      })}</title>
    </circle>`
  ).join("");

  const difference = values[values.length - 1] - values[0];
  const sign = difference > 0 ? "+" : "";

  setText(changeId, `${sign}${number(difference)} ${unit}`);

  const startLabel = formatDate(points[0].measured_at, {
    day: "numeric",
    month: "short"
  });

  const endLabel = formatDate(points[points.length - 1].measured_at, {
    day: "numeric",
    month: "short"
  });

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
        if (result && !scannerBusy) {
          scannerBusy = true;
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
      throw new Error("La base de produits est momentanément indisponible.");
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

    const kcal = nutriments["energy-kcal_100g"] ??
      (nutriments["energy-kj_100g"] != null
        ? Number(nutriments["energy-kj_100g"]) / 4.184
        : null);

    scannedProductData = {
      barcode,
      name: product.product_name || product.product_name_fr || "Produit sans nom",
      brand: product.brands || "",
      kcal: kcal == null ? 0 : Number(kcal),
      protein: Number(nutriments.proteins_100g || 0),
      carbs: Number(nutriments.carbohydrates_100g || 0),
      fat: Number(nutriments.fat_100g || 0)
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

function showScannedProduct() {
  const product = scannedProductData;
  if (!product) return;

  setText("scannedProductName", product.name);

  setText(
    "scannedProductDetails",
    product.brand ? `Marque : ${product.brand}` : "Marque non renseignée"
  );

  $("scanCalories").value = product.kcal;
  $("scanProtein").value = product.protein;
  $("scanCarbs").value = product.carbs;
  $("scanFat").value = product.fat;

  // La quantité doit obligatoirement être saisie par l'utilisateur.
  $("scanQuantity").value = "";

  showMessage("scanSaveMessage", "");

  $("scannerPanel")?.classList.add("hidden");
  $("scannedProduct")?.classList.remove("hidden");

  updateScanPreview();
  $("scanQuantity")?.focus();
}

function updateScanPreview() {
  const quantity = Math.max(0, Number($("scanQuantity")?.value || 0));
  const factor = quantity / 100;

  const kcal = Number($("scanCalories")?.value || 0) * factor;
  const protein = Number($("scanProtein")?.value || 0) * factor;
  const carbs = Number($("scanCarbs")?.value || 0) * factor;
  const fat = Number($("scanFat")?.value || 0) * factor;

  setText(
    "scanPreview",
    `Pour ${number(quantity, 0)} g : ${number(kcal, 0)} kcal · ` +
    `${number(protein)} g protéines · ${number(carbs)} g glucides · ` +
    `${number(fat)} g lipides`
  );
}

async function addScannedProduct() {
  const button = $("addScannedProduct");

  if (!client || !currentUser || !scannedProductData) {
    showMessage("scanSaveMessage", "Session ou produit manquant.", true);
    return;
  }

  const quantityInput = $("scanQuantity");
  const quantity = Number(quantityInput.value);

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

  const factor = quantity / 100;

  const row = {
    user_id: currentUser.id,
    product_name_snapshot: scannedProductData.name,
    quantity_g: quantity,
    kcal: Number($("scanCalories").value) * factor,
    protein_g: Number($("scanProtein").value) * factor,
    carbs_g: Number($("scanCarbs").value) * factor,
    fat_g: Number($("scanFat").value) * factor
  };

  button.disabled = true;
  showMessage("scanSaveMessage", "Enregistrement en cours…");

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
      `${productName} (${quantity} g) ajouté au journal.`
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

function cancelScannedProduct() {
  scannedProductData = null;
  $("scannedProduct")?.classList.add("hidden");
  $("scannerPanel")?.classList.add("hidden");
  showMessage("scanSaveMessage", "");
}

/* =====================================================
   WITHINGS
===================================================== */

async function connectWithings() {
  showMessage("withingsMessage", "Ouverture de la connexion Withings…");

  const { data: sessionData } = await client.auth.getSession();
  const token = sessionData.session?.access_token;

  if (!token) {
    showMessage("withingsMessage", "Session expirée. Reconnecte-toi.", true);
    return;
  }

  const { data, error } = await client.functions.invoke("withings-connect", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

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

async function syncWithings() {
  const button = $("withingsSync");
  button.disabled = true;

  showMessage("withingsMessage", "Synchronisation Withings en cours…");

  try {
    const { data: sessionData } = await client.auth.getSession();
    const token = sessionData.session?.access_token;

    if (!token) throw new Error("Session expirée. Reconnecte-toi.");

    const { data, error } = await client.functions.invoke("withings-sync", {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (error) throw error;

    showMessage(
      "withingsMessage",
      data?.message || `${data?.imported ?? 0} mesure(s) synchronisée(s).`
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

document.addEventListener("DOMContentLoaded", init);
