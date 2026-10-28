# Propagation

Jeu de grille de 2 à 8 joueurs. Chacun place des points sur ses cases ; à 4 points, une case déborde sur ses 4 voisines. Le dernier joueur qui a encore des cases gagne. Parties à distance avec un lien ou un code, en direct ou sur plusieurs jours, avec un classement Élo.

Contenu : `server.js` (le serveur, aucune dépendance), `engine.js` (les règles, partagées par le serveur et la page), `bot.js` (les joueurs IA), `index.html` (le jeu), `sw.js` + `manifest.webmanifest` + icônes (notifications et installation sur l'écran d'accueil), `package.json`, `render.yaml` (déploiement Render). Il faut seulement Node 18 ou plus.

## Ordinateur et téléphone

La même page s'adapte à l'écran. Sur ordinateur (fenêtre assez large), l'accueil passe sur deux colonnes (ton compte et tes parties à gauche, nouvelle partie et code à droite), et en partie la grille occupe la hauteur de l'écran avec les joueurs, le statut et les boutons à droite. Sur téléphone, tout reste en une colonne. Rien à installer.

## Modes

- 2, 4, 6 ou 8 joueurs, chacun pour soi. Grilles proposées : 5, 6 ou 8 (2 joueurs), 6, 8 ou 10 (4), 9, 10 ou 12 (6), 10, 12 ou 14 (8) ; la taille par défaut est la deuxième de la liste (6, 8, 10 ou 12). Sur ordinateur, la grille est plafonnée à 620 pixels. Chaque joueur a une couleur et une forme de point.
- **Rapide** : tout le monde est connecté. Si quelqu'un ne joue plus pendant 45 secondes, les autres peuvent l'éliminer.
- **Longue durée** : chaque joueur a 12, 24, 48 ou 72 heures par coup. On peut fermer la page entre deux coups. Un joueur qui dépasse son délai est éliminé.
- **Mort subite** (option, à 6 et 8 joueurs) : à partir du 30e tour (un tour = chaque joueur a joué une fois), puis tous les 5 tours, le bord de la grille disparaît. Le compte à rebours est affiché sous le statut ; dans les 5 derniers tours avant un rétrécissement, l'anneau qui va disparaître est entouré en pointillés rouges. Les points qui s'y trouvent sont détruits, ces cases ne peuvent plus être jouées et les débordements qui y arrivent sont perdus. Un joueur qui n'a plus de case est éliminé. Il reste toujours un carré de 2×2 ou 3×3 au centre. À cocher dans « Nouvelle partie » ou dans la salle d'attente (partie contre l'IA et « même écran » compris). Les IA ne tiennent pas compte du rétrécissement à venir : elles peuvent perdre des cases dessus.
- Départs équitables : à 2, 4 et 8 joueurs, les départs sont symétriques ; à 6 joueurs, chacun a la même surface à une case près (exactement la même en 9 × 9). La place de chacun et le premier joueur sont tirés au sort.
- Pendant la partie, les joueurs sont classés par nombre de points (numéro à gauche de chaque carte ; à égalité, même rang). En équipe, le classement est celui des équipes. Les joueurs éliminés passent en dernier ; à la fin, l'ordre final de la partie.
- « Abandonner » est possible à tout moment, « Revanche » relance avec les mêmes joueurs (et les mêmes équipes et IA).

## Compte, parties et Élo

- Au premier passage, le navigateur crée un compte automatiquement, sans inscription. Il est gardé sur l'appareil.
- « Mes parties » liste tes parties en cours et en attente avec ton côté : on y reprend là où on s'était arrêté, même après avoir fermé la page. Une partie terminée n'y reste que tant que tu n'as pas vu son résultat (par exemple une partie longue qui s'est terminée pendant ton absence) ; une fois ouverte, elle disparaît de la liste. Ton titre d'onglet indique quand c'est ton tour.
- **Code de récupération** : dans « Mon compte », un code de 30 caractères redonne ton compte (nom, Élo, parties) sur un autre appareil. Il donne accès au compte : ne le partage pas.
- **Élo** : tout le monde commence à 1000, K = 48 (32 × 1,5, voir Rangs). Les comptes créés avant le passage à l'échelle 700–3500 sont convertis automatiquement au premier démarrage (même droite que les IA ; les comptes sans partie repartent à 1000). Chaque paire de joueurs compte comme un duel selon le rang final (à N joueurs, chaque duel pèse K/(N-1)). Seules les parties « classées » dont toutes les places sont prises par des comptes différents comptent. Classement des 20 premiers dans le salon.

- **Rangs** : 15 rangs en 3 paliers de 5, désignés uniquement par leur lettre : D, C−, C, C+, B− · B, B+, A−, A, A+ · S−, S, S+, SS, X. L'échelle d'Élo va de 700 à 3500, par rangs de 200 points : D de 700 à 899, C− à partir de 900, C à 1100, … S− à 2700, SS à 3300, X à partir de 3500. Le rang X n'a pas de plafond : il se découpe en X0 (3500–3699), X1 (3700–3899), X2… un sous-niveau tous les 200 points, affiché en petit chiffre sur l'écusson. 700 est le plancher. Un nouveau joueur démarre à 1000 (milieu de C−). Les IA ont un Élo fixe sur la même échelle (Novice 700 … Grand maître 3500, donc X0), et la courbe d'Élo est étirée (×1,5) pour que gagner contre une IA forte rapporte autant qu'avant. L'écusson change de forme et de matière à chaque palier : plaque octogonale en acier (D à B−), gemme taillée au cadre doré (B à A+), bouclier ailé au cadre irisé (S− à X, avec une petite gemme au sommet dès S+) et la barre de progression sont dans le bandeau compte ; on les voit aussi dans le classement et sur les cartes des joueurs.
- **Page d'accueil** : en haut, ton nom, ton rang et ton Élo ; les notifications et le code de récupération sont repliés dans le même bandeau. « Mes parties » vient ensuite et n'apparaît que s'il y en a : seules les parties à reprendre sont listées (les terminées n'y sont jamais), celles où c'est ton tour en premier. « Nouvelle partie » demande seulement : adversaires, niveau de l'IA, nombre de joueurs, grille ; le rythme, la partie classée, la salle publique et la mort subite sont dans « Options » (replié, avec un résumé). Le « Classement » est une vitrine toujours visible : podium avec grands écussons pour les trois premiers, puis la suite jusqu'au 10e (bouton pour voir les 20) ; ta ligne apparaît en bas si tu n'y es pas. « Rejoindre une partie » et « Comment jouer » (un schéma et quatre phrases) suivent. Sur ordinateur, la page passe sur deux colonnes.
- **Rang visible partout** : dans la salle d'attente (sous chaque joueur : écusson, rang, Élo) et pendant la partie (sur chaque carte), pour les humains comme pour les IA, y compris en partie amicale.
- **Look jeu vidéo** : thème bleu clair, lisible et sans excès. Fond bleu ciel avec quelques bulles discrètes, bandeaux bleus à pois, pastilles blanches cernées de bleu nuit, titre jaune contouré. Les cartes des joueurs sont des pastilles avec un gros numéro de rang ; celle du joueur dont c'est le tour passe en bleu nuit. Sons synthétisés (aucun fichier) : pose, éclatement qui monte en hauteur dans une chaîne, début de tour, victoire, défaite, promotion. Le bouton rond en haut à droite coupe ou rétablit le son (retenu sur l'appareil). Les effets de mouvement sont coupés si l'appareil demande de réduire les animations.
- **Rituel de fin de partie classée** : à la fin d'une partie classée, une cérémonie s'ouvre : résultat, compteur d'Élo, écusson et barre de progression qui s'animent, avec « Promotion ! » et des confettis quand on monte de rang, ou « Relégation » quand on descend. Elle ne se rejoue pas pour une même partie (« Continuer » ou Échap pour fermer). Les animations sont coupées si ton appareil demande de réduire les animations.

## Salle d'attente et équipes

- **Salles ouvertes** : dans l'accueil, « Rejoindre une partie » liste les salles publiques où il reste une place (créateur et Élo, places prises, grille, rythme, classée ou non), qu'on rejoint d'un clic. Une salle est publique par défaut ; décoche « Salle publique » à la création ou dans la salle pour qu'elle ne soit accessible que par son code. Une salle rapide n'est listée que tant que son créateur est dedans ; une place tenue par une IA reste prenable. Les parties contre l'IA ne sont jamais listées.
- « Créer une salle » ouvre une salle d'attente avec un code et un lien. Le créateur y règle la partie (joueurs, grille, rythme, partie classée, équipes) et lance quand il veut ; les autres voient les réglages et choisissent leur place. L'option **« Lancer la partie dès que toutes les places sont prises »** est cochée par défaut : la partie démarre toute seule à l'arrivée du dernier joueur (ou quand le créateur complète avec des IA). Décoche-la, à la création (dans « Options ») ou dans la salle, pour lancer à la main.
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
- Ces Élo ont été mesurés par des parties entre les IA (1 contre 1, grille 8 × 8, 250 parties entre niveaux voisins, places et premier joueur tirés au sort). L'échelle va de 700 (Novice) à 3500 (Grand maître) : ce sont des repères entre IA, pas une mesure sur de vrais joueurs. À 4 joueurs ou plus, ces Élo restent une estimation.
- Si tu abandonnes à 4 joueurs ou plus, la partie s'arrête (les IA ne se battent pas entre elles) et tu finis dernier.

## Conquête (quatre camps, une carte)

Un mode à part, depuis la carte « Conquête » de l'accueil. Les règles :

- **Quatre camps :** eau, feu, air, terre. Chaque joueur en choisit un pour la semaine (il ne peut pas en changer avant lundi).
- **Une carte de 17 zones** de tailles différentes. Les quatre camps ont exactement la même carte (elle est symétrique) et démarrent chacun avec une zone.
- **Attaquer :** on attaque une zone qui touche une zone de son camp. Le combat est une partie contre l'IA qui défend la zone, sur une grille de la taille de la zone (a × b). Plus la zone est grande, plus l'IA est forte.
- **Points de vie :** chaque victoire retire 1 point de vie à la zone. À zéro, elle passe au camp du vainqueur, avec tous ses points de vie, et ce camp reçoit un bonus de capture (6 heures de production de la zone). 
- **Attaques :** chaque joueur en a 3 au départ, 5 au maximum, et une de plus toutes les 3 heures. Lancer un combat en coûte une, qu'on gagne ou qu'on perde (reprendre un combat en cours ne coûte rien).
- **Production :** toutes les 20 minutes, une zone de a × b rapporte (a + b) + (a × b) points à son camp (35 points pour 5 × 5, 120 pour le Nexus en 10 × 10).
- **Saison :** du lundi 00 h au lundi suivant (heure de Paris). Le camp qui a le plus de points gagne, puis la carte et les scores repartent de zéro et chacun peut changer de camp. Les saisons passées restent consultables.

Ce mode demande une sauvegarde durable (voir « Garder les parties ») : sans elle, la carte est remise à zéro à chaque redémarrage du serveur. Les réglages (tailles, niveaux d'IA, points de vie, bonus) sont en haut de `conquest.js`.

## Notifications « c'est ton tour »

Quand c'est à toi de jouer dans une partie que tu n'affiches pas (accueil, carte de conquête, autre partie), un bandeau jaune apparaît en haut de la page : un clic ouvre la partie.

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
