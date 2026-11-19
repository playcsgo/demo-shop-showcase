# slim 而不是 alpine：CLI 的 musl 支援未確認
FROM node:24-slim
# 版本固定：--bare 未來可能成為 -p 的預設，而 bare 不讀訂閱 token。升級前要重跑 llm:isolation
RUN npm install -g @anthropic-ai/claude-code@2.1.311 --no-audit --no-fund
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN chown -R node:node /app
USER node
CMD ["npm", "run", "start"]
