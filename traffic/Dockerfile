FROM ghcr.io/puppeteer/puppeteer:22
WORKDIR /app
COPY package.json .
RUN npm install
#RUN npm install dd-trace
COPY traffic.js .
#ENV NODE_OPTIONS="--require dd-trace/init"
CMD ["node", "traffic.js"]
