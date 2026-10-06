# 🚀 Render Deployment Guide

To deploy your quiz application to Render, follow these steps:

## 1. Prepare Your Repository
Ensure your project is pushed to a GitHub repository. Your project structure should look like this:
- `build.sh` (Created)
- `server.js` (Updated for Render)
- `package.json`
- `index.html`, `pages/`, etc.

## 2. Create a Web Service on Render
1. Log in to [dashboard.render.com](https://dashboard.render.com/).
2. Click **New +** and select **Web Service**.
3. Connect your GitHub repository.
4. Set the following configurations:
   - **Name**: `quiz-app` (or your choice)
   - **Environment**: `Docker` (Wait, I'm using Node.js/Build script, so **Node**)
   - **Build Command**: `./build.sh`
   - **Start Command**: `node server.js`
   - **Region**: Choose the one closest to your users.

## 3. Important Settings
Render expects your application to listen on a specific port. We've updated `server.js` to automatically use the `PORT` environment variable that Render provides.

### Persistence Note
> [!WARNING]
> Render's filesystem is **ephemeral**. Any changes to `data.json` will be lost when the application restarts or is redeployed. For a production quiz, consider using a database like Render's free PostgreSQL service or MongoDB.

## 4. Run Locally (Testing)
If you want to test the build process locally (requires a terminal that supports Bash like Git Bash on Windows):
```bash
./build.sh
node server.js
```
The server will now detect it's running locally and serve from the root/source files, but on Render, it will serve the optimized `dist` folder.

## 5. Verify Build
Check the **Logs** tab on Render after initiating the deploy. You should see `npm run build` executing and then `🚀 QUIZ MASTER SERVER RUNNING`.
