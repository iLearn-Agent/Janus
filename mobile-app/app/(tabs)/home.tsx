import { Pressable, SafeAreaView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useConnectionStore } from '@/stores/connectionStore';
import { sessions } from '@/mock/data';
import { colors, styles } from '@/theme';

export default function HomeScreen() {
  const connected = useConnectionStore((state) => state.connected);
  return <SafeAreaView style={styles.safe}><View style={styles.container}>
    <View style={styles.rowBetween}><View><Text style={styles.eyebrow}>JANUS</Text><Text style={styles.title}>你好，今天做什么？</Text></View><View style={styles.status}><View style={styles.dot} /><Text style={{ color: colors.success }}>电脑在线</Text></View></View>
    <Pressable style={styles.heroCard} onPress={() => router.push('/session/new')}><Text style={styles.heroTitle}>和 uBuddy 对话</Text><Text style={styles.heroSubtitle}>发送指令，让电脑端 Janus 继续工作</Text><Text style={styles.heroAction}>开始新会话 →</Text></Pressable>
    <Text style={styles.sectionTitle}>最近会话</Text>{sessions.slice(0, 3).map((item) => <Pressable key={item.id} style={styles.card} onPress={() => router.push(`/session/${item.id}`)}><Text style={styles.cardTitle}>{item.title}</Text><Text style={styles.muted}>{item.preview}</Text></Pressable>)}
    {!connected && <Text style={styles.muted}>尚未连接电脑</Text>}
  </View></SafeAreaView>;
}
