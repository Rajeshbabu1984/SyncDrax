@echo off
echo ====================================
echo  Syncora — Starting Backend Server
echo ====================================
echo.
cd /d "%~dp0backend"
pip install -r requirements.txt --quiet
echo.
echo Backend running at: http://localhost:8000
echo WebSocket at:       ws://localhost:8000/ws/{room}/{peer}/{name}
echo Health check:       http://localhost:8000/health
echo.
echo Open frontend\index.html in your browser to start.
echo Press Ctrl+C to stop.
echo.
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
