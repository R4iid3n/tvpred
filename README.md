# TVpred 📺 — Deploy sur Render gratuitement

Paris Polymarket live + Leaks Reddit · Zéro clé API · Zéro CB

---

## 🚀 Déploiement en 5 min sur Render (gratuit, sans CB)

### Étape 1 — Mettre le code sur GitHub

1. Va sur [github.com/new](https://github.com/new)
2. Crée un repo **tvpred** (public ou privé, ça marche)
3. Depuis ton terminal :

```bash
cd tvpred
git init
git add .
git commit -m "init"
git remote add origin https://github.com/TON_USERNAME/tvpred.git
git push -u origin main
```

### Étape 2 — Déployer sur Render

1. Va sur [render.com](https://render.com) → **Sign up** (avec GitHub, gratuit, sans CB)
2. Clique **New +** → **Web Service**
3. Connecte ton repo GitHub **tvpred**
4. Render détecte tout automatiquement grâce au `render.yaml` :
   - Build : `npm install`
   - Start : `node server.js`
5. Clique **Create Web Service**
6. ⏳ Attends ~2 min → ton URL : `https://tvpred.onrender.com`

### Étape 3 — Empêcher l'app de dormir (anti-sleep gratuit)

Le free tier Render dort après 15min d'inactivité. Fix gratuit :

1. Va sur [uptimerobot.com](https://uptimerobot.com) → créer un compte gratuit
2. **Add New Monitor** :
   - Type : **HTTP(s)**
   - URL : `https://tvpred.onrender.com/api/health`
   - Interval : **5 minutes**
3. Clique **Create Monitor**

→ L'app reste éveillée 24h/24, gratuitement.

---

## Lancer en local

```bash
npm install
node server.js
# → http://localhost:3000
```

## Structure

```
tvpred/
├── server.js          ← backend Express (proxy Polymarket + Reddit)
├── public/
│   └── index.html     ← frontend
├── render.yaml        ← config déploiement Render
└── package.json
```
