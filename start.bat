@echo off
echo ==============================================
echo STARTING QUIZ APP (NODE.JS + PYTHON BACKEND)
echo ==============================================
echo.

:: Check Node modules
IF NOT EXIST "node_modules" (
    echo [1/2] Installing Node.js dependencies...
    call npm install
) ELSE (
    echo [1/2] Node modules already installed.
)

:: Check Python dependencies
echo [2/2] Installing Python dependencies...
cd python_backend
pip install -r requirements.txt -q
cd ..

echo.
echo ==============================================
echo  Node.js server  : http://localhost:3000
echo  Python backend   : http://localhost:5000
echo ==============================================
echo  Press Ctrl+C to stop both servers.
echo ==============================================
echo.

:: Start both servers concurrently
npx concurrently -n "NODE,PYTHON" -c "cyan,yellow" "node server.js" "cd python_backend && python app.py"
