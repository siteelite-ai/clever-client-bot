FROM node:22.16.0-alpine3.21

ENV NODE_ENV=production
WORKDIR /app
COPY --chown=node:node server.mjs /app/server.mjs
USER node
EXPOSE 19084
CMD ["node", "/app/server.mjs"]
