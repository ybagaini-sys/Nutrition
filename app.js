(() => {
  const $ = id => document.getElementById(id);
  const cfg = window.FORME_CONFIG || {};
  const configured = cfg.SUPABASE_URL?.startsWith("https://") &&
    cfg.SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_publishable_");
  const setup = $("setupNotice"), auth = $("authPanel"), dashboard = $("dashboard");
  const badge = $("connectionBadge"), authMessage = $("authMessage");
  if (!configured || !window.supabase) {
    setup.classList.remove("hidden");
    badge.textContent = "Configuration requise";
    return;
  }

  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  let currentUser = null, profile = null, foodRows = [], foodSubmitting = false;
  let targets = { kcal: 2050, protein: 160, fat: 65, carbs: 206 };

  const dateKey = () => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());

  const startOfWeek = () => {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    d.setHours(0, 0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
  };

  const ageFrom = birth => {
    if (!birth) return null;
    const b = new Date(birth + "T12:00:00"), n = new Date();
    let a = n.getFullYear() - b.getFullYear();
    if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
    return a;
  };
  const n0 = v => Number(v || 0);
  const fmt = v => Math.round(v).toLocaleString("fr-CH");

  function showAuth(message = "") {
    auth.classList.remove("hidden");
    dashboard.classList.add("hidden");
    authMessage.textContent = message;
  }
  function progress(id, value, target) {
    $(id).style.width = Math.max(0, Math.min(100, target ? value / target * 100 : 0)) + "%";
  }
  function setMsg(id, text, error = false) {
    $(id).textContent = text;
    $(id).classList.toggle("error", error);
  }

  async function loadDashboard(session) {
    currentUser = session.user;
    auth.classList.add("hidden");
    dashboard.classList.remove("hidden");
    badge.textContent = "Connecté";
    $("userLabel").textContent = session.user.email || "Compte personnel";
    $("todayLabel").textContent = new Intl.DateTimeFormat("fr-CH", {
      weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Zurich"
    }).format(new Date()).toUpperCase();

    const [pRes, wRes, nRes, sRes] = await Promise.all([
      client.from("profiles").select("*").eq("user_id", currentUser.id).maybeSingle(),
      client.from("body_measurements").select("*").eq("user_id", currentUser.id).order("measured_at", { ascending: false }).limit(1),
      client.from("nutrition_logs").select("id,consumed_at,meal_type,product_name_snapshot,quantity_g,kcal,protein_g,carbs_g,fat_g").eq("user_id", currentUser.id)
        .gte("consumed_at", dateKey() + "T00:00:00+01:00").lt("consumed_at", dateKey() + "T23:59:59+01:00"),
      client.from("strength_workouts").select("id", { count: "exact", head: true }).eq("user_id", currentUser.id).gte("started_at", startOfWeek())
    ]);
    if (pRes.error) {
      $("syncStatus").textContent = "Erreur de lecture du profil : " + pRes.error.message;
      return;
    }
    profile = pRes.data || {};
    foodRows = nRes.data || [];
    renderFoodHistory();
    const age = ageFrom(profile.birth_date), height = n0(profile.height_cm);
    const targetWeight = n0(profile.target_weight_kg) || 72;
    const referenceWeight = wRes.data?.[0]?.weight_kg ? n0(wRes.data[0].weight_kg) : 80;
    const bmr = 10 * referenceWeight + 6.25 * height - 5 * (age || 46) + 5;
    const tdee = bmr * 1.45;
    targets.kcal = Math.round((tdee - 350) / 50) * 50;
    targets.protein = 160;
    targets.fat = 65;
    targets.carbs = Math.round((targets.kcal - targets.protein * 4 - targets.fat * 9) / 4);

    $("ageValue").textContent = age === null ? "Non renseigné" : age + " ans";
    $("heightValue").textContent = height ? height + " cm" : "—";
    $("targetValue").textContent = targetWeight + " kg";
    $("weightGoal").textContent = targetWeight + " kg";
    $("targetCaloriesValue").textContent = fmt(targets.kcal) + " kcal";
    $("caloriesTarget").textContent = "Objectif provisoire : " + fmt(targets.kcal) + " kcal";
    $("proteinTarget").textContent = "Objectif : 160 g";
    $("weightValue").textContent = wRes.data?.[0]?.weight_kg ? n0(wRes.data[0].weight_kg).toFixed(1) + " kg" : "—";
    $("weightDate").textContent = wRes.data?.[0]?.measured_at
      ? "Dernière mesure : " + new Intl.DateTimeFormat("fr-CH", { dateStyle: "medium" }).format(new Date(wRes.data[0].measured_at))
      : "Aucune mesure enregistrée";
    if (wRes.data?.[0]?.weight_kg) {
      const delta = n0(wRes.data[0].weight_kg) - targetWeight;
      $("weightProgress").textContent = delta > 0 ? delta.toFixed(1) + " kg au-dessus de l'objectif" : "Objectif atteint ou dépassé";
    } else {
      $("weightProgress").textContent = "Ajoute une première mesure pour démarrer le suivi.";
    }
    $("workoutsValue").textContent = sRes.error ? "—" : (sRes.count || 0);

    const totals = (nRes.data || []).reduce((a, r) => ({
      kcal: a.kcal + n0(r.kcal), protein: a.protein + n0(r.protein_g),
      carbs: a.carbs + n0(r.carbs_g), fat: a.fat + n0(r.fat_g)
    }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });

    $("caloriesValue").textContent = fmt(totals.kcal);
    $("proteinValue").textContent = fmt(totals.protein) + " g";
    $("calorieMacro").textContent = fmt(totals.kcal) + " / " + fmt(targets.kcal) + " kcal";
    $("proteinMacro").textContent = fmt(totals.protein) + " / 160 g";
    progress("calorieBar", totals.kcal, targets.kcal);
    progress("proteinBar", totals.protein, 160);
    $("syncStatus").textContent = "Dernière lecture Supabase : " + new Date().toLocaleTimeString("fr-CH");
  }


  const safeText = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  function renderFoodHistory(){
    const host=$("foodHistory");
    $("foodCount").textContent=foodRows.length+(foodRows.length===1?" entrée":" entrées");
    if(!foodRows.length){host.innerHTML='<p class="muted">Aucune consommation enregistrée aujourd’hui.</p>';return;}
    host.innerHTML=foodRows.map((r,i)=>{
      const time=new Intl.DateTimeFormat("fr-CH",{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Zurich"}).format(new Date(r.consumed_at));
      return `<div class="food-entry"><div class="food-entry-main"><strong>${safeText(r.product_name_snapshot||"Consommation")}</strong><small>${time} · ${fmt(n0(r.kcal))} kcal · ${fmt(n0(r.protein_g))} g protéines · G ${fmt(n0(r.carbs_g))} g · L ${fmt(n0(r.fat_g))} g</small></div><div class="food-entry-actions"><button class="quiet edit-food" data-i="${i}" type="button">Modifier</button><button class="quiet delete-food" data-i="${i}" type="button">Supprimer</button></div></div>`;
    }).join("");
    host.querySelectorAll(".edit-food").forEach(b=>b.addEventListener("click",()=>editFood(foodRows[Number(b.dataset.i)])));
    host.querySelectorAll(".delete-food").forEach(b=>b.addEventListener("click",()=>deleteFood(foodRows[Number(b.dataset.i)])));
  }
  function editFood(r){
    const host=$("foodHistory").querySelectorAll(".food-entry")[foodRows.indexOf(r)];
    host.innerHTML=`<strong>Modifier la consommation</strong><div class="food-edit">
      <div class="wide"><label>Aliment</label><input id="editName" value="${safeText(r.product_name_snapshot||"")}"></div>
      <div><label>Calories</label><input id="editKcal" type="number" min="0" value="${n0(r.kcal)}"></div>
      <div><label>Protéines (g)</label><input id="editProtein" type="number" min="0" step=".1" value="${n0(r.protein_g)}"></div>
      <div><label>Glucides (g)</label><input id="editCarbs" type="number" min="0" step=".1" value="${n0(r.carbs_g)}"></div>
      <div><label>Lipides (g)</label><input id="editFat" type="number" min="0" step=".1" value="${n0(r.fat_g)}"></div></div>
      <div class="food-entry-actions"><button class="primary save-food" type="button">Enregistrer</button><button class="quiet cancel-food" type="button">Annuler</button></div>`;
    host.querySelector(".cancel-food").addEventListener("click",renderFoodHistory);
    host.querySelector(".save-food").addEventListener("click",async()=>{
      const b=host.querySelector(".save-food");b.disabled=true;
      try{
        const {error}=await client.from("nutrition_logs").update({product_name_snapshot:$("editName").value.trim(),kcal:n0($("editKcal").value),protein_g:n0($("editProtein").value),carbs_g:n0($("editCarbs").value),fat_g:n0($("editFat").value)}).eq("id",r.id).eq("user_id",currentUser.id);
        if(error)throw error;setMsg("foodMessage","Consommation modifiée.");await loadDashboard({user:currentUser});
      }catch(e){setMsg("foodMessage","Modification impossible : "+e.message,true);b.disabled=false;}
    });
  }
  async function deleteFood(r){
    if(!window.confirm(`Supprimer « ${r.product_name_snapshot||"cette consommation"} » ?`))return;
    try{const {error}=await client.from("nutrition_logs").delete().eq("id",r.id).eq("user_id",currentUser.id);if(error)throw error;setMsg("foodMessage","Consommation supprimée.");await loadDashboard({user:currentUser});}
    catch(e){setMsg("foodMessage","Suppression impossible : "+e.message,true);}
  }

  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const form = e.currentTarget;
    const b = form.querySelector("button");
    b.disabled = true;
    b.textContent = "Connexion…";
    try {
      const { data, error } = await client.auth.signInWithPassword({
        email: $("email").value.trim(), password: $("password").value
      });
      if (error) throw error;
      await loadDashboard(data.session);
    } catch (error) {
      showAuth("Connexion impossible : " + error.message);
    } finally {
      b.disabled = false;
      b.textContent = "Se connecter";
    }
  });

  $("logoutButton").addEventListener("click", async () => {
    await client.auth.signOut();
    badge.textContent = "Déconnecté";
    showAuth();
  });

  $("refreshButton").addEventListener("click", () => {
    client.auth.getSession().then(({ data }) => data.session && loadDashboard(data.session));
  });

  $("weightForm").addEventListener("submit", async e => {
    e.preventDefault();
    const form = e.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const weight = Number($("weightInput").value);
    button.disabled = true;
    setMsg("weightMessage", "Enregistrement…");
    try {
      const { error } = await client.from("body_measurements").insert({
        user_id: currentUser.id, measured_at: new Date().toISOString(), source: "manual", weight_kg: weight
      });
      if (error) throw error;
      form.reset();
      setMsg("weightMessage", "Pesée enregistrée.");
      await loadDashboard({ user: currentUser });
    } catch (error) {
      setMsg("weightMessage", "Enregistrement impossible : " + error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  $("foodForm").addEventListener("submit", async e => {
    e.preventDefault();
    if (foodSubmitting) return;
    const form = e.currentTarget; // Mémoriser avant await : currentTarget disparaît après l'événement.
    const button = form.querySelector('button[type="submit"]');
    const payload = {
      user_id: currentUser.id,
      consumed_at: new Date().toISOString(),
      meal_type: "manual",
      product_name_snapshot: $("foodName").value.trim(),
      quantity_g: 1,
      kcal: n0($("foodKcal").value),
      protein_g: n0($("foodProtein").value),
      carbs_g: n0($("foodCarbs").value),
      fat_g: n0($("foodFat").value)
    };
    foodSubmitting = true;
    button.disabled = true;
    setMsg("foodMessage", "Enregistrement…");
    try {
      const { error } = await client.from("nutrition_logs").insert(payload);
      if (error) throw error;
      form.reset();
      setMsg("foodMessage", "Consommation ajoutée au journal.");
      await loadDashboard({ user: currentUser });
    } catch (error) {
      setMsg("foodMessage", "Ajout impossible : " + error.message, true);
    } finally {
      foodSubmitting = false;
      button.disabled = false;
    }
  });

  client.auth.onAuthStateChange((event, session) => {
    if (session && event !== "TOKEN_REFRESHED") loadDashboard(session);
    else if (!session) showAuth();
  });
  client.auth.getSession().then(({ data }) => data.session ? loadDashboard(data.session) : showAuth());
})();