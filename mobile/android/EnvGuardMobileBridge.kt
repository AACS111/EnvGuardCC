package io.github.aacs111.envguardcc.vpn

import android.app.Activity
import android.content.Intent
import android.net.VpnService
import android.os.Build
import android.provider.Settings
import android.util.Log
import envguardcore.Envguardcore
import envguardcore.VpnDelegate
import java.io.File
import java.util.TimeZone

/**
 * Host Activity helper wired into the Tauri Android MainActivity.
 *
 * Responsibilities:
 *   1. Starts the embedded Go/mihomo mobile core (loopback helper + gateway APIs).
 *   2. Handles Android VpnService.prepare() permission flow.
 *   3. Provides read-only OS timezone & one-tap jump to Android Date & Time settings.
 */
class EnvGuardMobileBridge(
    private val activity: Activity,
    private val appVersion: String
) : VpnDelegate {

    companion object {
        private const val TAG = "EnvGuardMobileBridge"
        const val REQUEST_VPN_PERMISSION = 39080
    }

    private var pendingPerApp = false
    private var pendingAllowedApps: ArrayList<String> = arrayListOf()

    fun startCore() {
        val stateDir = File(activity.filesDir, "envguard-state").apply { mkdirs() }
        val abi = Build.SUPPORTED_ABIS.firstOrNull() ?: "arm64-v8a"
        Envguardcore.startCore(stateDir.absolutePath, appVersion, "android", abi, 128)
        Envguardcore.setVpnDelegate(this)
        Log.i(
            TAG,
            "Mobile core ready: helper=${Envguardcore.getHelperPort()}, gateway=${Envguardcore.getGatewayPort()}"
        )
    }

    fun stopCore() {
        runCatching { requestStopVPN() }
        runCatching { Envguardcore.stopCore() }
    }

    override fun requestStartVPN() {
        val prepareIntent = VpnService.prepare(activity)
        if (prepareIntent != null) {
            activity.runOnUiThread {
                activity.startActivityForResult(prepareIntent, REQUEST_VPN_PERMISSION)
            }
            return
        }
        launchVpnService()
    }

    override fun requestStopVPN() {
        val intent = Intent(activity, EnvGuardVpnService::class.java).apply {
            action = EnvGuardVpnService.ACTION_STOP
        }
        activity.startService(intent)
    }

    override fun readSystemTimezone(): String {
        return TimeZone.getDefault().id
    }

    fun onActivityResult(requestCode: Int, resultCode: Int): Boolean {
        if (requestCode != REQUEST_VPN_PERMISSION) return false
        if (resultCode == Activity.RESULT_OK) {
            launchVpnService()
        } else {
            Log.w(TAG, "User declined VPN authorization")
        }
        return true
    }

    fun configurePerAppProxy(enabled: Boolean, apps: List<String>) {
        pendingPerApp = enabled
        pendingAllowedApps = ArrayList(apps)
    }

    fun openSystemTimezoneSettings() {
        val intent = Intent(Settings.ACTION_DATE_SETTINGS).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
    }

    private fun launchVpnService() {
        val intent = Intent(activity, EnvGuardVpnService::class.java).apply {
            action = EnvGuardVpnService.ACTION_START
            putExtra(EnvGuardVpnService.EXTRA_PER_APP_PROXY, pendingPerApp)
            putStringArrayListExtra(EnvGuardVpnService.EXTRA_ALLOWED_APPS, pendingAllowedApps)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(intent)
        } else {
            activity.startService(intent)
        }
    }
}
