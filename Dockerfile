FROM node:22-alpine

WORKDIR /app

# Package fayllarini nusxalash
COPY package*.json ./

# Qaramliklarni o'rnatish
RUN npm install --production

# Prisma o'rnatish (client generatsiya qilish uchun)
RUN npm install prisma @prisma/client

# Prisma schema nusxalash va generatsiya
COPY prisma ./prisma
RUN npx prisma generate

# Dastur kodlarini nusxalash
COPY . .

# Portni ochish
EXPOSE 5000

# Dasturni ishga tushirish
CMD ["npm", "start"]
