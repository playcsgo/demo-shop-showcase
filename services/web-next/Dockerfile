# Next.js 版的前台＋BFF。WEB_RUNTIME=next 時，這個 image 會掛在 bff-gateway 的名稱下（比照 core-go），
# 所以 port（3000）和環境變數的名稱都跟 NestJS 版相同
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# rewrites 在 build 時寫死（見 next.config.ts），所以客服的位址要在這裡給
ARG SUPPORT_URL=http://support:3000
ENV SUPPORT_URL=$SUPPORT_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Datadog 開著時，chart 和 compose 會給每個 Node 服務 NODE_OPTIONS=--import dd-trace/initialize.mjs（和 NestJS 版同一套）。
# standalone 只帶 Next.js 用到的套件，所以另外裝，版本和 bff-gateway 相同。裝在自己的目錄再連結過去：它的相依套件不會和 Next.js 的混在一起
FROM node:24-alpine AS ddtrace
RUN npm install --prefix /opt/dd --omit=dev --no-audit --no-fund dd-trace@6.20.1

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 WEB_RUNTIME=next
# standalone 只帶 server.js 和用到的 node_modules；靜態檔和 public 要自己複製
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=ddtrace /opt/dd /opt/dd
RUN ln -s /opt/dd/node_modules/dd-trace /app/node_modules/dd-trace
USER node
EXPOSE 3000
CMD ["node", "server.js"]
