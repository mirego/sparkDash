#!/bin/bash

# Exit immediately if any command fails
set -e

# Self-contained deploy stack (card t_4495562c): docker-compose.deploy.yml is
# the tracked deploy override — SSH key mounts + live config mount + host
# networking. docker-compose.override.yml is local-dev convenience and is
# intentionally empty of deploy concerns; deploying with it (alone) is what
# silently dropped the SSH key in the v2.0.1 rebuild.
compose() { docker compose -f docker-compose.yml -f docker-compose.deploy.yml "$@"; }

echo "Stopping and removing containers..."
compose down

echo "Building images..."
if ! compose build; then
  echo ""
  echo "Build failed. If you saw auth.docker.io / 'network is unreachable' on an IPv6 address,"
  echo "Docker Hub is being reached over broken IPv6. This repo pulls Node from"
  echo "public.ecr.aws (IPv4-first). Pull latest deploy.sh + Dockerfiles and retry."
  echo "Host workaround: add this line to /etc/gai.conf then retry:"
  echo "  precedence ::ffff:0:0/96  100"
  exit 1
fi

echo "Starting services in detached mode..."
compose up -d

echo "Post-deploy SSH smoke check (card t_4495562c)..."
if ! ./scripts/post-deploy-verify.sh; then
  echo ""
  echo "❌ SSH smoke check FAILED — the container lost its SSH identity or cannot reach key-auth Sparks."
  echo "   Deploy is NOT healthy. Inspect with: docker exec sparkDash sh -lc 'ls -l \$HOME/.ssh'"
  exit 1
fi

echo "✅ All done! Services are now running and SSH-verified."
