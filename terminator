Pour créer un script Python qui tourne en continu sur Debian 13 et surveille les doublons, la méthode la plus propre et la plus robuste est de combiner un script Python basé sur le calcul de **hash MD5** (pour garantir que les fichiers sont identiques, même s'ils ont des noms différents) et un **service systemd**.

Voici la solution complète.

### 1. Le script Python (`deduplicator.py`)

Ce script scanne le dossier, compare les contenus des fichiers et supprime les doublons. Il utilise un intervalle de sommeil pour ne pas surcharger le processeur.

Crée le fichier : `nano /home/papaours/deduplicator.py`

```python
import os
import hashlib
import time

# Configuration
TARGET_DIR = "/home/papaours/Téléchargements/"
SLEEP_INTERVAL = 3600  # Vérification toutes les heures (en secondes)

def calculate_md5(file_path):
    """Calcule le hash MD5 d'un fichier pour comparer le contenu."""
    hash_md5 = hashlib.md5()
    try:
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(4096), b""):
                hash_md5.update(chunk)
        return hash_md5.hexdigest()
    except (PermissionError, FileNotFoundError):
        return None

def remove_duplicates():
    if not os.path.exists(TARGET_DIR):
        print(f"Erreur : Le dossier {TARGET_DIR} n'existe pas.")
        return

    print(f"Analyse des doublons dans {TARGET_DIR}...")
    seen_hashes = {}
    
    # Liste tous les fichiers du dossier
    for filename in os.listdir(TARGET_DIR):
        file_path = os.path.join(TARGET_DIR, filename)
        
        # On ne traite que les fichiers (pas les dossiers)
        if os.path.isfile(file_path):
            file_hash = calculate_md5(file_path)
            
            if file_hash:
                if file_hash in seen_hashes:
                    print(f"Suppression du doublon : {filename} (Identique à {seen_hashes[file_hash]})")
                    try:
                        os.remove(file_path)
                    except Exception as e:
                        print(f"Erreur lors de la suppression de {filename} : {e}")
                else:
                    seen_hashes[file_hash] = filename

if __name__ == "__main__":
    while True:
        remove_duplicates()
        print(f"Vérification terminée. Prochaine analyse dans {SLEEP_INTERVAL/60} minutes.")
        time.sleep(SLEEP_INTERVAL)
```

---

### 2. Créer le Service Systemd (Pour le 24h/24)

Pour que le script survive au redémarrage et tourne en arrière-plan sans que tu aies besoin de laisser un terminal ouvert, on va créer un service.

1.  **Crée le fichier de service :**
    ```bash
    sudo nano /etc/systemd/system/deduplicator.service
    ```

2.  **Colle le contenu suivant :**
    ```ini
    [Unit]
    Description=Service de suppression des doublons Papaours
    After=network.target

    [Service]
    ExecStart=/usr/bin/python3 /home/papaours/deduplicator.py
    User=papaours
    Group=papaours
    Restart=always
    RestartSec=10

    [Install]
    WantedBy=multi-user.target
    ```

3.  **Active et lance le service :**
    ```bash
    sudo systemctl daemon-reload
    sudo systemctl enable deduplicator.service
    sudo systemctl start deduplicator.service
    ```

---

### 3. Comment vérifier que ça fonctionne ?

* **Pour voir l'état du service :**
    ```bash
    sudo systemctl status deduplicator.service
    ```
* **Pour voir les logs (ce que le script a supprimé) :**
    ```bash
    journalctl -u deduplicator.service -f
    ```

### Pourquoi cette méthode ?
* **Hash MD5 :** Contrairement à une simple vérification du nom, si tu télécharges `photo.jpg` et `photo(1).jpg`, le script verra qu'ils sont identiques et supprimera le second.
* **Systemd :** C'est la méthode standard sur Debian 13 pour gérer les processus 24h/24. Si le script plante, Linux le relancera automatiquement.
* **Économie d'énergie :** Le script "dort" la majorité du temps (`time.sleep`), donc il n'impactera pas tes performances de jeu ou de navigation sur Debian.

> **Attention :** Ce script est radical. Si deux fichiers sont identiques mais que tu voulais garder les deux exemplaires pour une raison précise, le script supprimera le plus récent. Assure-toi que c'est bien ce que tu veux !
