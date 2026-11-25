@echo off
echo Starting Quiz Master Django Server...
python manage.py migrate --noinput
python manage.py runserver 0.0.0.0:8000
pause
