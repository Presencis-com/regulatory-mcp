FROM node:22-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
COPY data ./data
RUN npm install --ignore-scripts && npm run build
ENTRYPOINT ["node", "dist/index.js"]
