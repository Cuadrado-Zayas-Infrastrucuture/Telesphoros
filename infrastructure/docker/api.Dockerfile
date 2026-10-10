# FD-4b: no credentials, deployment, Python, or synthetic reader in this image.
FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.28.0
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @telesphoros/backend build
# Legacy deploy keeps workspace isolation without altering the shared lockfile.
RUN node infrastructure/docker/dependency-graph.cjs record && pnpm --filter @telesphoros/backend deploy --legacy --prod /output && node infrastructure/docker/dependency-graph.cjs compare
# Removes only throwaway build output, never the checkout.
RUN rm -rf /output/src /output/test /output/scripts /output/*.mjs /output/jest.config.js /output/tsconfig*.json /output/README.md && find /output -name '*.map' -delete

FROM node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94 AS runtime
WORKDIR /app
# Fixed versions from the blocking scan; unavailable fixes fail the build.
RUN apt-get update && apt-get install --yes --no-install-recommends --only-upgrade \
    libcap2=1:2.66-4+deb12u3+b1 libgnutls30=3.7.9-2+deb12u7 \
    libpcre2-8-0=10.42-1+deb12u2 perl-base=5.36.0-7+deb12u4 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /output/ ./
COPY infrastructure/docker/global-bundle.pem infrastructure/docker/global-bundle.sha256 /opt/telesphoros/ca/
RUN cd /opt/telesphoros/ca && sha256sum --check global-bundle.sha256
# Removes only installer tools inherited from the base; runtime never installs packages.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production NODE_EXTRA_CA_CERTS=/opt/telesphoros/ca/global-bundle.pem
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["node"]
CMD ["dist/main.js"]
