FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine AS serve
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/pharmacy/browser /usr/share/nginx/html

FROM node:24-bookworm-slim AS test
WORKDIR /app
COPY package*.json ./
RUN npm ci && npx playwright install --with-deps chromium
COPY . .
CMD ["npm", "test"]
