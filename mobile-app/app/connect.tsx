import { useState } from 'react';
import { Alert, Pressable, SafeAreaView, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useConnectionStore } from '@/stores/connectionStore';
import { colors, styles } from '@/theme';

export default function ConnectScreen() {
  const [url, setUrl] = useState('http://192.168.1.20:3210/mobile');
  const [code, setCode] = useState('');
  const pair = useConnectionStore((state) => state.pair);
  return <SafeAreaView style={styles.safe}><View style={styles.container}>
    <Text style={styles.brand}>Janus Mobile</Text><Text style={styles.title}>连接你的电脑</Text>
    <Text style={styles.subtitle}>手机只负责传达指令，任务仍在电脑端 Janus 执行。</Text>
    <TextInput value={url} onChangeText={setUrl} autoCapitalize="none" style={styles.input} placeholder="电脑地址" />
    <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" style={styles.input} placeholder="6 位配对码" />
    <Pressable style={styles.primaryButton} onPress={() => { if (!code.trim()) return Alert.alert('请输入配对码'); pair(url, code); router.replace('/(tabs)/home'); }}><Text style={styles.primaryText}>配对并继续</Text></Pressable>
  </View></SafeAreaView>;
}
