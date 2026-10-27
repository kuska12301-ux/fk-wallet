FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node dist ./dist
COPY --chown=node:node sdk ./sdk
COPY --chown=node:node examples ./examples
RUN mkdir -p /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "server/index.mjs"]
