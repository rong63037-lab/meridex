FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
ENV NODE_ENV=production \
    PORT=4317 \
    HOST=0.0.0.0 \
    API_INTERNAL_URL=http://gateway:7108
RUN npm run build
EXPOSE 4317
CMD ["npm", "start"]
