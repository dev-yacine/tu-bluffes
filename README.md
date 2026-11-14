# 🃏 Tu bluffes !

Jeu de cartes multijoueur en ligne (2 à 10 joueurs), jouable sur téléphone et ordinateur.

## Lancer le jeu

Prérequis : [Node.js](https://nodejs.org) 16 ou plus.

```bash
npm install
npm start
```

Ouvre http://localhost:3000, crée un salon, puis envoie le lien d'invitation (bouton « Copier le lien ») à tes amis.

## Jouer avec des amis à distance

**Option 1 : tester tout de suite depuis ton PC** (tunnel temporaire)

```bash
npm start
# dans un autre terminal :
npx cloudflared tunnel --url http://localhost:3000
# ou : ngrok http 3000
```

Partage l'adresse https affichée. Elle ne marche que tant que ton PC et le serveur restent allumés.

**Option 2 : hébergement permanent gratuit/pas cher** (Render, Railway, Fly.io, un VPS…)

- Dépose ce dossier sur GitHub, crée un « Web Service » Node.
- Commande de build : `npm install` — commande de démarrage : `npm start`.
- Le serveur lit la variable `PORT` automatiquement et expose `/healthz`.
- Les WebSockets passent par https (`wss://`) sans configuration.

> Sur les offres gratuites, le serveur peut s'endormir après quelques minutes d'inactivité : le premier chargement est alors plus lent, et les parties en cours sont perdues si le serveur redémarre (tout est gardé en mémoire).

## Règles implémentées

- 54 cartes (52 + **2 jokers**) mélangées et distribuées équitablement.
- Le premier joueur (tiré au sort) pose **1 à 4 cartes face cachées** et annonce un chiffre : « un six ».
- Chacun son tour, les autres posent **1 à 4 cartes** en prétendant qu'elles ont le même chiffre, ou **passent**. Le nombre annoncé peut dépasser le nombre réel de cartes existantes.
- À son tour, un joueur peut accuser **uniquement le dernier joueur qui vient de poser** : « Tu bluffes ! ». On retourne **les cartes de ce dernier dépôt** (les dépôts précédents ne comptent plus) :
  - au moins une carte fausse → bluff confirmé : l'accusé ramasse tout le tapis ;
  - toutes les cartes sont bonnes → l'accusateur ramasse tout le tapis.
- **Celui qui n'a pas ramassé** relance ensuite un nouveau tour avec le chiffre de son choix.
- **Le chiffre ne change que si tous les autres joueurs passent** d'affilée : le tapis **reste en place** (il n'est pas ramassé) et le dernier joueur à avoir posé relance avec le chiffre de son choix. Si ce joueur vient de finir ses cartes, c'est **le joueur suivant** qui relance.
- **Jokers** : ne valent jamais le chiffre annoncé, donc toujours un bluff si on les pose (et on est forcé de s'en débarrasser en bluffant).
- **Finir ses cartes** : si tu poses ta dernière carte, les autres joueurs ne peuvent plus qu'accuser ou passer. Si personne ne t'accuse à raison, tu as fini : tu sors de la table (1er, 2e, 3e…) et le joueur suivant relance. La partie se termine quand il ne reste qu'un joueur ; le premier à avoir fini est le vainqueur.

## Réglages modifiables dans `server.js`

- `MAX_PER_TURN` : nombre maximum de cartes posées par tour (4 par défaut).
- `STOP_AT_FIRST_WINNER` : `true` pour arrêter la partie dès que le premier joueur a fini (au lieu de continuer jusqu'au classement complet).
- Fonction `act` : règles d'accusation, de ramassage et de relance.

## Fonctionnement technique

- `server.js` : serveur HTTP + WebSocket (`ws`). Le serveur est la seule source de vérité : chaque joueur ne reçoit que sa propre main et le nombre de cartes des autres, donc impossible de tricher en regardant le trafic réseau.
- `public/index.html` : toute l'interface (aucune dépendance côté navigateur).
- Reconnexion automatique : si un joueur recharge la page ou perd le réseau, il revient dans sa partie. Un joueur parti n'est retiré qu'au salon (après 30 s), pas en pleine partie.