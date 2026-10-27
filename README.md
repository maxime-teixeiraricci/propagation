# Propagation

Jeu de grille de 2 à 8 joueurs. Chacun place des points sur ses cases ; à 4 points, une case déborde sur ses 4 voisines. Le dernier joueur qui a encore des cases gagne. Parties à distance avec un lien ou un code, en direct ou sur plusieurs jours, avec un classement Élo.

Contenu : `server.js` (le serveur, aucune dépendance), `engine.js` (les règles, partagées par le serveur et la page), `bot.js` (les joueurs IA), `index.html` (le jeu), `sw.js` + `manifest.webmanifest` + icônes (notifications et installation sur l'écran d'accueil), `package.json`, `render.yaml` (déploiement Render). Il faut seulement Node 18 ou plus.

## Modes

- 2, 4, 6 ou 8 joueurs, chacun pour soi. Chaque joueur a une couleur et une forme de point.
- **Rapide** : tout le monde est connecté. Si quelqu'un ne joue plus pendant 45 secondes, les autres peuvent l'éliminer.
- **Longue durée** : chaque joueur a 12, 24, 48 ou 72 heures par coup. On peut fermer la page entre deux coups. Un joueur qui dépasse son délai est éliminé.
- Départs équitables : à 2, 4 et 8 joueurs, les départs sont symétriques ; à 6 joueurs, chacun a la même surface à une case près. La place de chacun et le premier joueur sont tirés au sort.
- Pendant la partie, les joueurs sont classés par nombre de points (numéro à gauche de chaque carte ; à égalité, même rang). En équipe, le classement est celui des équipes. Les joueurs éliminés passent en dernier ; à la fin, l'ordre final de la partie.
- « Abandonner » est possible à tout moment, « Revanche » relance avec les mêmes joueurs (et les mêmes équipes et IA).

## Compte, parties et Élo

- Au premier passage, le navigateur crée un compte automatiquement, sans inscription. Il est gardé sur l'appareil.
- « Mes parties » liste toutes tes parties avec ton côté : on y reprend là où on s'était arrêté, même après avoir fermé la page. Ton titre d'onglet indique quand c'est ton tour.
- **Code de récupération** : dans « Mon compte », un code de 30 caractères redonne ton compte (nom, Élo, parties) sur un autre appareil. Il donne accès au compte : ne le partage pas.
- **Élo** : tout le monde commence à 1000, K = 32. Chaque paire de joueurs compte comme un duel selon le rang final (à N joueurs, chaque duel pèse K/(N-1)). Seules les parties « classées » dont toutes les places sont prises par des comptes différents comptent. Classement des 20 premiers dans le salon.

## Salle d'attente et équipes

- « Créer une salle » ouvre une salle d'attente avec un code et un lien. Le créateur y règle la partie (joueurs, grille, rythme, partie classée, équipes) et lance quand il veut ; les autres voient les réglages et choisissent leur place.
- **IA dans la salle** : sur chaque place libre, le créateur peut ajouter une IA du niveau voulu (ou « Compléter » toutes les places libres). Si un ami arrive alors que toutes les places sont prises par des IA, il prend la place d'une IA. Avec 3 amis dans une salle à 4, ajoute une IA et lance.
- Sans équipes, les places vides sont retirées au lancement (3 occupants = partie à 3 joueurs, départs un peu moins symétriques qu'à 2, 4, 6 ou 8).
- **Équipes** : 2 équipes (2 contre 2, 3 contre 3, 4 contre 4), 3 équipes de 2 ou 4 équipes de 2. Les équipes sont formées par les places (A, B, A, B…, ce qui garde des départs équitables) : en choisissant ta place, tu choisis ton équipe. Toutes les places doivent être prises (complète avec des IA).
- Règles d'équipe : tu ajoutes toujours un point sur *tes* cases. Quand une case déborde, les cases d'un coéquipier reçoivent le point mais **restent à leur propriétaire** ; les cases adverses et vides passent de ton côté. Un joueur sans case est éliminé, son équipe continue. Une équipe gagne quand toutes les cases restantes sont à ses membres.
- Élo en équipe : chaque équipe est comptée avec l'Élo moyen de ses joueurs, et tous les joueurs d'une équipe gagnent ou perdent la même chose. Les IA gardent leur Élo fixe.
- Les IA jouent en équipe avec leurs coéquipiers (humains ou IA). Dans une partie avec IA, si plus aucun humain n'est en jeu (tous abandonnent ou sont éliminés), la partie s'arrête.

## Jouer contre l'ordinateur

- Dans « Nouvelle partie », choisis « L'ordinateur (IA) », un niveau, le nombre de joueurs (2 : toi contre une IA ; 4, 6 ou 8 : toi contre 3, 5 ou 7 IA du même niveau) et la grille. La partie démarre tout de suite, sans salle d'attente, et reste dans « Mes parties ».
- 11 niveaux, du Novice (coups au hasard) au Grand maître (qui regarde aussi ta réponse avant de jouer). Les niveaux se distinguent par la réflexion et une part de coups au hasard, de plus en plus faible.
- Chaque niveau a un **Élo fixe**, affiché dans la liste : il ne bouge jamais. Une partie classée contre l'IA modifie ton Élo comme contre un joueur de ce niveau : battre un niveau plus fort que toi rapporte plus, battre un niveau bien plus faible presque rien. Décoche « Partie classée » pour jouer sans enjeu.
- Ces Élo ont été mesurés par des parties entre les IA (1 contre 1, grille 8 × 8, 250 parties entre niveaux voisins, places et premier joueur tirés au sort). L'échelle est calée en donnant 1000 au niveau « Amateur » : ce sont des repères entre IA, pas une mesure sur de vrais joueurs. À 4 joueurs ou plus, ces Élo restent une estimation.
- Si tu abandonnes à 4 joueurs ou plus, la partie s'arrête (les IA ne se battent pas entre elles) et tu finis dernier.

## Notifications « c'est ton tour »

- Dans « Mon compte », le bouton « Activer les notifications » prévient cet appareil quand c'est son tour, même page fermée. Il faut l'activer sur chaque appareil (ordinateur, téléphone).
- En partie longue, un rappel est envoyé quand il reste peu de temps : 3 heures, ou un quart du délai s'il est plus court.
- Pas de notification si tu regardes déjà la partie, page visible.
- **iPhone / iPad** : Apple n'autorise les notifications que pour un site ajouté à l'écran d'accueil (iOS 16.4 ou plus). Dans Safari : Partager, « Sur l'écran d'accueil », puis ouvre le jeu depuis son icône et active les notifications.
- Rien à configurer côté serveur : la clé d'envoi est créée au premier démarrage. Avec une base Upstash elle est conservée ; sans, elle change à chaque redémarrage et chaque appareil se réabonne tout seul à l'ouverture suivante de la page.
- Les notifications ne contiennent aucune donnée de partie : le navigateur reçoit un simple signal, puis demande au serveur quelles parties l'attendent. Seuls les services de notification des navigateurs (Google, Mozilla, Apple, Microsoft) sont acceptés comme destinations.

## Essayer chez toi

```
node server.js
```

Ouvre http://localhost:3000. « Jouer sur le même écran » permet de tester seul.

En local, les comptes, l'Élo et les parties sont gardés dans le dossier `data/` (fichier `data.json`) : tu peux arrêter et relancer le serveur sans rien perdre. Pour repartir de zéro, supprime ce dossier.

## Mettre en ligne gratuitement (Render)

1. Dépôt GitHub avec ces fichiers à la racine.
2. Sur render.com : New > Blueprint, choisis le dépôt, valide. Render lit `render.yaml`.
3. Tu obtiens une adresse du type `https://propagation-xxxx.onrender.com`. C'est le jeu.

À chaque mise à jour du dépôt, Render redéploie tout seul.

## Garder les parties (indispensable pour les parties de plusieurs jours)

Le disque de l'offre gratuite de Render est effacé à chaque redémarrage ou mise en veille. Sans stockage externe, **les comptes, l'Élo et les parties sont perdus** (la page affiche alors un avertissement dans « Mon compte »). La solution gratuite : une base Upstash Redis.

1. Crée un compte gratuit sur upstash.com, puis « Create Database » (Redis, région proche, plan Free).
2. Dans la page de la base, section **REST API**, copie `UPSTASH_REDIS_REST_URL` et `UPSTASH_REDIS_REST_TOKEN`.
3. Sur Render : ton service > Environment, ajoute ces deux variables avec leurs valeurs. Render redémarre.
4. Vérifie : `https://ton-adresse.onrender.com/health` doit afficher `"durable":true`.

Le serveur sauvegarde chaque coup, et recharge tout au démarrage. Les parties terminées sont gardées 30 jours, les parties en attente 7 jours, les parties en cours inactives 3 jours.

## À savoir

- Après une mise en veille (15 min sans visite sur l'offre gratuite), le premier chargement prend 30 à 60 secondes. Les délais des parties longues ne sont contrôlés que serveur réveillé ; au réveil, chaque joueur reçoit 30 minutes de grâce. Pour éviter la veille, un service gratuit comme UptimeRobot peut appeler `/health` toutes les 5 minutes.
- Le service gratuit de Render s'endort : une notification n'est envoyée que lorsque le serveur est réveillé (voir UptimeRobot ci-dessus pour qu'il ne dorme pas).
- Quiconque connaît le code d'une partie peut la rejoindre (si une place est libre) ou la regarder.
- Rien n'empêche quelqu'un de créer plusieurs comptes pour s'échanger de l'Élo : les parties amicales (case « Partie classée » décochée) ne comptent pas.
