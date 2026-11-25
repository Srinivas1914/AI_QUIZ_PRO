from django.urls import path
from . import api_views, billing_views, views

urlpatterns = [
    # HTML Pages
    path('', views.index_view, name='index'),
    path('index.html', views.index_view, name='index_html'),
    path('superadmin', views.superadmin_view, name='superadmin'),
    path('superadmin/', views.superadmin_view),
    path('admin', views.admin_view, name='admin_panel'),
    path('admin/', views.admin_view),
    path('participant', views.participant_view, name='participant'),
    path('participant/', views.participant_view),
    path('team/<str:name>', views.team_view, name='team'),
    path('camera-monitor.html', views.camera_monitor_view, name='camera_monitor'),
    path('live-feed.html', views.live_feed_view, name='live_feed'),

    # Core Auth & Users
    path('api/client-ip', api_views.api_client_ip),
    path('api/login', api_views.api_login),
    path('api/register', api_views.api_register),
    path('api/users/delete', api_views.api_delete_user),

    # Real-Time Sync Engine
    path('api/sync/state', api_views.api_sync_state),
    path('api/sync/push', api_views.api_sync_push),
    path('api/sync/cmd', api_views.api_sync_cmd),
    path('api/sync/audio', api_views.api_sync_audio),

    # Reports & Analytics
    path('api/reports', api_views.api_reports_save),
    path('api/reports/<str:quiz_id>', api_views.api_reports_list),
    path('api/admin-perf', api_views.api_admin_perf),

    # AI Generation
    path('api/ai/test-key', api_views.api_ai_test_key),
    path('api/ai/generate', api_views.api_ai_generate_direct),
    path('py-api/ai/generate', api_views.py_ai_generate),

    # Payments & Entitlements
    path('py-api/payment/create_order', api_views.py_payment_create_order),
    path('py-api/payment/verify', api_views.py_payment_verify),
    path('py-api/payment/mark-failed', api_views.py_payment_mark_failed),
    path('py-api/payment-settings', api_views.py_payment_settings),
    path('py-api/quiz-start/create_order', api_views.py_quiz_start_create_order),
    path('py-api/quiz-start/verify', api_views.py_quiz_start_verify),
    path('py-api/entitlements/current', api_views.py_entitlements_current),
    path('py-api/entitlements/all', api_views.py_entitlements_all),
    path('py-api/quiz-start/activate', api_views.py_quiz_start_activate),
    path('py-api/record-login', api_views.py_record_login),
    path('py-api/payments', api_views.py_get_payments),
    path('py-api/payment/retry', api_views.py_payment_retry),
    path('py-api/admin-details/<str:admin_id>', api_views.py_admin_details),

    # Enterprise Billing Platform APIs
    path('api/billing/overview', billing_views.billing_overview),
    path('api/billing/subscriptions', billing_views.billing_subscriptions),
    path('api/billing/subscriptions/<str:code>/action', billing_views.billing_subscription_action),
    path('api/billing/ai-wallet', billing_views.billing_ai_wallet),
    path('api/billing/risk', billing_views.billing_risk),
    path('api/billing/notifications', billing_views.billing_notifications),
    path('api/billing/coupons', billing_views.billing_coupons),
    path('api/billing/coupons/bulk', billing_views.billing_coupons_bulk),
    path('api/billing/coupons/validate', billing_views.billing_coupons_validate),
    path('api/billing/gateway-health', billing_views.billing_gateway_health),
    path('api/billing/roles', billing_views.billing_roles),
    path('api/billing/refunds', billing_views.billing_refunds),
    path('api/billing/tickets', billing_views.billing_tickets),
    path('api/billing/address', billing_views.billing_address),
    path('api/billing/audit', billing_views.billing_audit_list),
    path('api/billing/audit/export', billing_views.billing_audit_export),
    path('api/billing/invoice/<str:order_id>.pdf', billing_views.billing_invoice_pdf),
    path('api/billing/webhook', billing_views.billing_webhook),
    path('api/billing/portal', billing_views.billing_portal),
]
