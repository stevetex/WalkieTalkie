# Relay node image (option E): Caddy terminates TLS and proxies to the relay on
# 127.0.0.1:8080, in one container. Built by deploy/gcp/build-image.sh with Cloud Build.
FROM caddy:2 AS caddy

FROM node:24-slim
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
# Caddy binds 80 and 443 as the unprivileged node user.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libcap2-bin \
  && setcap cap_net_bind_service=+ep /usr/local/bin/caddy \
  && apt-get purge -y libcap2-bin && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY container/entrypoint.sh ./container/

ARG REVISION=unknown
ENV NODE_ENV=production \
    REVISION=$REVISION \
    STORE=firestore \
    HOST=127.0.0.1 \
    PORT=8080 \
    DRAIN_MS=45000 \
    XDG_DATA_HOME=/data \
    XDG_CONFIG_HOME=/data/config

USER node
RUN export XDG_DATA_HOME=/tmp/validate XDG_CONFIG_HOME=/tmp/validate \
  && RELAY_HOSTNAMES="relay-1.example.com relay.example.org" ACME_EMAIL=ops@example.com container/entrypoint.sh --validate \
  && container/entrypoint.sh --validate && rm -rf /tmp/validate /tmp/Caddyfile

# /data is the node's persistent disk: Caddy's certificates and ACME account.
VOLUME /data
ENTRYPOINT ["/app/container/entrypoint.sh"]
