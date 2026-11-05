FROM node:22-alpine AS build
WORKDIR /app
COPY docker/package.json docker/package-lock.json ./
RUN npm ci
COPY nodes/shared ./nodes/shared
COPY nodes/AgyAccount/auth.ts ./nodes/AgyAccount/auth.ts
COPY nodes/AgyChatModel/cli.ts ./nodes/AgyChatModel/cli.ts
COPY docker/src ./docker/src
RUN ./node_modules/.bin/esbuild docker/src/server.cjs --bundle --platform=node --target=node22 --format=cjs --outfile=build/server.cjs
RUN AGY_CLI_CACHE_DIR=/app/agy-runtime node -e "require('./build/server.cjs').prepareRuntime().then(p=>console.log('Installed CLI:',p)).catch(e=>{console.error(e);process.exit(1)})"

FROM node:22-alpine
RUN apk add --no-cache ca-certificates su-exec
WORKDIR /app
COPY --from=build /app/build/server.cjs ./server.cjs
COPY docker/public ./public
COPY --from=build /app/agy-runtime /opt/agy-runtime
COPY docker/entrypoint.sh /usr/local/bin/agy-entrypoint
RUN chmod 755 /usr/local/bin/agy-entrypoint
RUN mkdir -p /home/node/.gemini /home/node/.n8n /home/node/.agy-api && chown -R node:node /home/node
ENV NODE_ENV=production AGY_PUBLIC_DIR=/app/public HOME=/home/node
EXPOSE 8080
ENTRYPOINT ["agy-entrypoint"]
CMD ["node", "server.cjs"]
