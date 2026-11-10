# FD-4b: no credentials, deployment, Python, or synthetic reader in this image.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS build
WORKDIR /workspace
RUN npm install --global pnpm@10.28.0
# Dependency fetch depends only on reviewed lock/workspace inputs. Source-only
# changes reuse that layer; the install and both application builds still run.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --frozen-lockfile --offline
RUN pnpm --filter @telesphoros/backend build
# The background worker is one self-contained bundle (its workspace packages are compiled in); it runs from this same image as `node worker/main.js` and needs only
# modules the API already ships (pg, zod, the AWS SDK).
RUN pnpm --filter @telesphoros/worker build
# Legacy deploy keeps workspace isolation without altering the shared lockfile.
# Remove only checkout backlinks from the disposable deploy output; the existing
# graph comparison still refuses any missing or changed production dependency.
RUN node infrastructure/docker/dependency-graph.cjs record && pnpm --filter @telesphoros/backend deploy --legacy --prod /output && find /output -type l -lname '*workspace/*' -delete && node infrastructure/docker/dependency-graph.cjs compare
# Removes only throwaway build output, never the checkout.
RUN rm -rf /output/src /output/test /output/scripts /output/*.mjs /output/jest.config.js /output/tsconfig*.json /output/README.md && find /output -name '*.map' -delete
RUN mkdir /output/worker && cp apps/worker/dist/main.js /output/worker/main.js

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS runtime_files
WORKDIR /runtime-input
# Fixed versions from the blocking scan; unavailable fixes fail the build. glibc and dpkg are below the gate (Debian rates them medium/low) but
# the registry scan reports them high, and Debian has fixes (2026-10-30), so they are pinned too.
RUN apt-get update && apt-get install --yes --no-install-recommends --only-upgrade \
    libcap2=1:2.66-4+deb12u3+b1 libgnutls30=3.7.9-2+deb12u7 \
    libpcre2-8-0=10.42-1+deb12u2 perl-base=5.36.0-7+deb12u4 \
    libc6=2.36-9+deb12u14 libc-bin=2.36-9+deb12u14 dpkg=1.21.23 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /output/ ./
COPY infrastructure/docker/global-bundle.pem infrastructure/docker/global-bundle.sha256 /opt/telesphoros/ca/
RUN cd /opt/telesphoros/ca && sha256sum --check global-bundle.sha256
COPY infrastructure/docker/runtime-rootfs.cjs /tmp/runtime-rootfs.cjs
RUN node /tmp/runtime-rootfs.cjs /runtime-rootfs

# Carry only Node's reviewed shared-library closure, not the build OS utilities.
# The generated root retains Debian identity and the copied libraries' inventory.
FROM scratch AS runtime
COPY --from=runtime_files /runtime-rootfs/ /
COPY --from=build /output/ /app/
# Synthetic knowledge for the structured assessment (spec 032 S3): invented genes and drugs, data only. The API reads it only while SYNTHETIC_ASSESSMENT is enabled.
COPY --from=build /workspace/data/fixtures/knowledge/synthetic-structured/ /app/synthetic-knowledge/
COPY --from=runtime_files /opt/telesphoros/ca/ /opt/telesphoros/ca/
WORKDIR /app
# Report intake stages uploads in /tmp, where ECS mounts the task's ephemeral `scratch` volume (api-compute.tf). ECS gives that volume the image's /tmp
# permissions (1777, from runtime-rootfs.cjs) only for a path the image declares a VOLUME; without it the volume is root-owned 0755 and user 10001 cannot write.
VOLUME ["/tmp"]
ENV PATH=/usr/local/bin NODE_ENV=production NODE_EXTRA_CA_CERTS=/opt/telesphoros/ca/global-bundle.pem LANG=C LC_ALL=C LANGUAGE=C
USER 10001:10001
EXPOSE 3000
ENTRYPOINT ["node"]
CMD ["dist/main.js"]
