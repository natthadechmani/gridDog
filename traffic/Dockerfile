FROM ghcr.io/puppeteer/puppeteer:22
WORKDIR /app
COPY package.json .
RUN npm install
COPY traffic.js .
CMD ["node", "traffic.js"]
