#!/bin/bash
# Start the reverse gateway server

cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo "Error: .env file not found. Copy .env.example to .env and configure it."
    exit 1
fi

echo "Starting reverse gateway..."
python main.py
