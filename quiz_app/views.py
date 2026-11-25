from django.shortcuts import render


def index_view(request):
    return render(request, 'index.html')


def superadmin_view(request):
    return render(request, 'pages/superadmin.html')


def admin_view(request):
    return render(request, 'pages/admin.html')


def participant_view(request):
    return render(request, 'pages/participant.html')


def team_view(request, name):
    return render(request, 'pages/team.html', {'team_name': name})


def camera_monitor_view(request):
    return render(request, 'camera-monitor.html')


def live_feed_view(request):
    return render(request, 'live-feed.html')
