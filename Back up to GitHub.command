#!/bin/bash
# Saves the Story Studio code to your private GitHub repo.
# Your projects folder (images, audio, videos) is NOT uploaded: it is listed in .gitignore.
# First run: it asks for your repo address. After that, double-click it any time to back up.
cd "$(dirname "$0")"

if ! command -v git >/dev/null 2>&1; then
  echo "Git is not installed. macOS will offer to install it if you run:  xcode-select --install"
  read -n 1 -s -r -p "Press any key to close."
  exit 1
fi

if [ ! -d .git ]; then
  git init -b main >/dev/null
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin https://github.com/Ayordeji/Youtube-Story-Studio.git
fi

if [ -z "$(git config user.email)" ]; then
  git config user.email "Ayordeji@users.noreply.github.com"
  git config user.name "Ayordeji"
fi

git add -A
if git diff --cached --quiet; then
  echo "Nothing new to save."
else
  git commit -m "Backup $(date '+%Y-%m-%d %H:%M')" >/dev/null && echo "Saved a new backup point."
fi

if git push -u origin main; then
  echo "Done. Your code is on GitHub."
else
  echo ""
  echo "The push failed. Most often GitHub needs you to sign in. Try:  gh auth login   (if you use the GitHub CLI)"
  echo "or create a personal access token on github.com and use it as the password when asked."
fi
read -n 1 -s -r -p "Press any key to close."
