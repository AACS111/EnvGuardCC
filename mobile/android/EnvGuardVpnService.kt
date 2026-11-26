package io.github.aacs111.envguardcc.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import envguardcore.Envguardcore
import envguardcore.SocketProtector

/**
 * EnvGuardCC Android VpnService.
 *
 * Creates a system TUN interface and hands its detached file descriptor to the
 * embedded Go/mihomo mobile core (EnvGuardCore.aar). Also implements
 * SocketProtector so outbound proxy sockets bypass the VPN interface.
 */
class EnvGuardVpnService : VpnService(), SocketProtector {

    companion object {
        private const val TAG = "EnvGuardVpnService"
        const val ACTION_START = "io.github.aacs111.envguardcc.vpn.START"
        const val ACTION_STOP = "io.github.aacs111.envguardcc.vpn.STOP"
        const val EXTRA_PER_APP_PROXY = "per_app_proxy"
        const val EXTRA_ALLOWED_APPS = "allowed_apps"
        private const val CHANNEL_ID = "envguardcc_vpn"
        private const val NOTIFICATION_ID = 39081
        private const val TUN_MTU = 9000
    }

    private var tunInterface: ParcelFileDescriptor? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        Envguardcore.setSocketProtector(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopTunnelAndSelf()
                return START_NOT_STICKY
            }
            ACTION_START, null -> {
                val perApp = intent?.getBooleanExtra(EXTRA_PER_APP_PROXY, false) ?: false
                val allowedApps = intent?.getStringArrayListExtra(EXTRA_ALLOWED_APPS) ?: arrayListOf()
                startForegroundNotification()
                startTunnel(perApp, allowedApps)
                return START_STICKY
            }
        }
        return START_NOT_STICKY
    }

    override fun protect(fd: Long): Boolean {
        return super.protect(fd.toInt())
    }

    override fun onRevoke() {
        Log.w(TAG, "VPN permission revoked by system")
        stopTunnelAndSelf()
        super.onRevoke()
    }

    override fun onDestroy() {
        stopTunnelInternal()
        super.onDestroy()
    }

    private fun startTunnel(perAppProxy: Boolean, allowedApps: List<String>) {
        stopTunnelInternal()
        try {
            val builder = Builder()
                .setSession("EnvGuardCC")
                .setMtu(TUN_MTU)
                .addAddress("198.18.0.1", 16)
                .addDnsServer("198.18.0.2")
                .addRoute("0.0.0.0", 0)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                builder.setMetered(false)
            }

            if (perAppProxy && allowedApps.isNotEmpty()) {
                for (pkg in allowedApps) {
                    if (pkg == packageName) continue
                    runCatching { builder.addAllowedApplication(pkg) }
                        .onFailure { Log.w(TAG, "Skip unavailable package $pkg: ${it.message}") }
                }
            } else {
                // Exclude EnvGuardCC itself so loopback & upstream dials never recurse.
                runCatching { builder.addDisallowedApplication(packageName) }
            }

            val pfd = builder.establish()
                ?: throw IllegalStateException("VpnService.Builder.establish() returned null")
            tunInterface = pfd
            Envguardcore.startTunnel(pfd.fd.toLong(), TUN_MTU.toLong())
            Log.i(TAG, "VPN tunnel established (fd=${pfd.fd}, mtu=$TUN_MTU)")
        } catch (err: Exception) {
            Log.e(TAG, "Failed to establish VPN tunnel", err)
            stopTunnelAndSelf()
        }
    }

    private fun stopTunnelInternal() {
        runCatching { Envguardcore.stopTunnel() }
        runCatching { tunInterface?.close() }
        tunInterface = null
    }

    private fun stopTunnelAndSelf() {
        stopTunnelInternal()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        stopSelf()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID,
                "EnvGuardCC Protection Tunnel",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps EnvGuardCC fixed-exit VPN protection active"
            }
            manager.createNotificationChannel(channel)
        }
    }

    private fun startForegroundNotification() {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pending = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        }
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setContentTitle("EnvGuardCC 环境防护运行中")
            .setContentText("正在通过固定出口保护 Claude 网络连接")
            .setSmallIcon(android.R.drawable.ic_lock_lock)
            .setOngoing(true)
            .apply { if (pending != null) setContentIntent(pending) }
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }
}
