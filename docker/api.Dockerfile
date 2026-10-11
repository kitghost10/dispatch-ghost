# syntax=docker/dockerfile:1.7
# API + Twilio voice gateway. The same image runs the BullMQ worker
# (`node apps/api/dist/worker.js`) and migrations (`pnpm --filter @sb/db migrate`).
FROM node:22.20-bookworm-slim
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@10.30.3
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/providers/package.json packages/providers/
RUN pnpm install --frozen-lockfile --filter "@sb/api..." --filter "sonicbold-receptionist"
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @sb/api build
ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
