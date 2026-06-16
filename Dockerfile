FROM node:20-slim
WORKDIR /app
COPY package.json server.js index.html ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
