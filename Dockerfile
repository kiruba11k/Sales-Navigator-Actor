FROM apify/actor-node-playwright-chrome:20

# 2. Copy package.json and install dependencies
COPY package*.json ./
RUN npm install --include=dev --audit=false

# 3. Copy the rest of your code (main.js, etc.)
COPY . ./

# 4. Run the script defined in your package.json
CMD ["npm", "start"]
