# syntax=docker/dockerfile:1
# vps3 self-fronting nginx: TLS (self-signed, /etc/ssl/lfr) + reverse proxy
# to the worker's own console on loopback (network_mode: host, same as
# ../docker-compose.yml's backend service — no tunnel, no separate edge host).
ARG NGINX_VERSION=1.29-alpine
FROM nginx:${NGINX_VERSION}
COPY front/nginx-vps3-local.conf /etc/nginx/conf.d/lfr.conf
RUN rm -f /etc/nginx/conf.d/default.conf
EXPOSE 443 80
