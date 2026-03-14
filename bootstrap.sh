#!/usr/bin/env bash
set -e

echo "======================================"
echo " Lobster Dev Environment Bootstrap"
echo "======================================"

# -----------------------------
# Check OS
# -----------------------------
OS="$(uname)"

echo "Detected OS: $OS"

# -----------------------------
# Install dependencies
# -----------------------------
if [[ "$OS" == "Darwin" ]]; then
  if ! command -v brew &> /dev/null; then
    echo "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi

  brew update
  brew install pyenv

elif [[ "$OS" == "Linux" ]]; then
  if ! command -v pyenv &> /dev/null; then
    echo "Installing pyenv..."

    curl https://pyenv.run | bash

    export PATH="$HOME/.pyenv/bin:$PATH"
    eval "$(pyenv init -)"
  fi
fi

# -----------------------------
# Setup pyenv
# -----------------------------
export PATH="$HOME/.pyenv/bin:$PATH"
eval "$(pyenv init -)"

# -----------------------------
# Install Python
# -----------------------------
PYTHON_VERSION="3.11.8"

if ! pyenv versions | grep "$PYTHON_VERSION" > /dev/null; then
  echo "Installing Python $PYTHON_VERSION via pyenv..."
  pyenv install $PYTHON_VERSION
fi

pyenv local $PYTHON_VERSION

echo "Using Python:"
python --version

# -----------------------------
# Create virtualenv
# -----------------------------
if [ ! -d ".venv" ]; then
  echo "Creating virtual environment..."
  python -m venv .venv
fi

source .venv/bin/activate

echo "Virtualenv activated"

# -----------------------------
# Upgrade pip
# -----------------------------
pip install --upgrade pip setuptools wheel

# -----------------------------
# Install requirements
# -----------------------------
if [ -f "requirements.txt" ]; then
  echo "Installing dependencies..."
  pip install -r requirements.txt
fi

# -----------------------------
# Final check
# -----------------------------
echo ""
echo "Environment ready!"
echo ""

echo "Python path:"
which python

echo "Python version:"
python --version

echo "Pip path:"
which pip

echo "======================================"
echo " Lobster bootstrap completed"
echo "======================================"
