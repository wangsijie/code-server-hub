FROM node:lts
WORKDIR /app
COPY package.json /app/
COPY yarn.lock /app/
RUN yarn install --production
COPY . /app/
CMD [ "node", "app.js" ]
